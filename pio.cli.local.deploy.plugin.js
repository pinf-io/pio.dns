
const ASSERT = require("assert");
const DNS = require("dns");
const CRYPTO = require("crypto");
const Q = require("q");
const REQUEST = require("request");


var provisionMemoryCache = {};

exports.deploy = function(pio, state) {

    var response = {
        declared: {},
        resolving: {},
        status: "unknown"
    };

    return pio.API.Q.fcall(function() {

        // TODO: Use abstracted API to get this config info.
        if (
            !state['pio.services'].services[state['pio.service'].id].descriptor['config.plugin'] ||
            !state['pio.services'].services[state['pio.service'].id].descriptor['config.plugin']['pio.dns'] ||
            !state['pio.services'].services[state['pio.service'].id].descriptor['config.plugin']['pio.dns'].records
        ) {
            return;
        }
        var records = state['pio.services'].services[state['pio.service'].id].descriptor['config.plugin']['pio.dns'].records;
        // TODO: This should already be done when we get the config from the abstracted API above.
        records = JSON.stringify(records);
        records = records.replace(/\{\{config\['pio\.vm'\]\.ip\}\}/g, state['pio.vm'].ip);
        records = JSON.parse(records);

        function lookup(name) {
            return pio.API.Q.denodeify(DNS.resolve4)(name).fail(function(err) {
                console.error("Warning: Error looking up hostname '" + name + "':", err.stack);
                return [];
            });
        }

        var all = [];
        records = Object.keys(records).map(function(name) {
            response.declared[name] = records[name];
            all.push(lookup(name).then(function(ips) {
                response.resolving[name] = ips;
            }));                
            return {
                domain: records[name].domain,
                type: records[name].type,
                name: name,
                data: records[name].data
            };
        });

        return Q.all(all).then(function() {

            for (var name in records) {
                if (records[name].type === "A") {
                    if (
                        response.resolving[name] &&
                        response.resolving[name][0] === records[name].data
                    ) {
                        // Record is resolving.
                        delete records[name];
                    }
                } else
                if (records[name].type === "CNAME") {
                    // TODO: We should be checking all records here for all services, not just for our one service.
                    if (!response.declared[records[name].data]) {
                        throw new Error("CNAME '" + records[name].data + "' must be declared in records!");
                    }
                    // TODO: Allow multiple layers of CNAMES until reaching an A record.
                    if (
                        response.resolving[records[name].data] &&
                        response.resolving[records[name].data][0] === response.declared[records[name].data].data
                    ) {
                        // Record is resolving.
                        delete records[name];
                    }
                } else {
                    throw new Error("Unrecognized record type '" + records[name].type + "' for record: " + JSON.stringify(records[name]));
                }
            }

            return pio.API.Q.all(all).then(function() {
                if (Object.keys(records).length === 0) {
                    response.status = "ready";
                    return;
                }

                function ensureWithAdapter(name, settings) {
                    if (!settings) return Q.resolve();

                    var cacheKey = JSON.stringify(name, settings, records);
                    if (provisionMemoryCache[cacheKey]) {
                        console.log("Skip provision as we already did previously in this process.".yellow);
                        return;
                    }
                    provisionMemoryCache[cacheKey] = true;

                    // TODO: Use `require.async`.
                    var adapter = require("./adapters/" + name);
                    var adapter = new adapter.adapter(settings);
                    console.log(("Provisioning DNS records using adapter '" + name + "': " + JSON.stringify(records, null, 4)).magenta);
                    return adapter.ensure(records);
                }

                var all = [];
                for (var name in pio.getConfig("config")["pio.dns"].adapters) {
                    all.push(ensureWithAdapter(name, pio.getConfig("config")["pio.dns"].adapters[name]));
                }
                return Q.all(all);
            });
        });

    }).then(function() {
        return pio.API.Q.resolve({
            "pio.dns": response
        });
    });
}
