
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
        ".status": "unknown"
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
        records = records.replace(/\{\{config\.pio\.domain\}\}/g, state['pio'].domain);
        records = records.replace(/\{\{config\.pio\.hostname\}\}/g, state['pio'].hostname);
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
            records = records.filter(function(record) {
                if (record.type === "A") {
                    if (
                        response.resolving[record.name] &&
                        response.resolving[record.name][0] === record.data
                    ) {
                        // Record is resolving.
                        return false;
                    }
                } else
                if (record.type === "CNAME") {
                    // TODO: We should be checking all records here for all services, not just for our one service.
                    if (!response.declared[record.data]) {

                        // NOTE: For now we just assume CNAME records are not resolving.
                        return true;
//                        throw new Error("CNAME '" + record.data + "' must be declared in records!");
                    }
                    // TODO: Allow multiple layers of CNAMES until reaching an A record.
                    if (
                        response.resolving[record.name] &&
                        response.resolving[record.name][0] === response.declared[record.data].data
                    ) {
                        // Record is resolving.
                        return false;
                    }
                } else {
                    throw new Error("Unrecognized record type '" + record.type + "' for record: " + JSON.stringify(record));
                }
                return true;
            });

            return pio.API.Q.all(all).then(function() {
                if (Object.keys(records).length === 0) {
                    response[".status"] = "ready";
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
