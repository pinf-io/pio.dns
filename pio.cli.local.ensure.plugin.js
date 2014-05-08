
const ASSERT = require("assert");
const DNS = require("dns");
const CRYPTO = require("crypto");
const Q = require("q");
const REQUEST = require("request");


var ready = false;
var provisionMemoryCache = {};

exports.ensure = function(pio, state) {

    // POLICY: You must include enough information in the response so tooling can compare
    //         declared vs provisioned. i.e. The tooling must not need to query the original config
    //         when looking at *.rt.json. It also shows exactly the declared config used for provisioning.
    var response = {
        declared: {},
        resolving: {},
        status: "unknown"
    };

    return pio.API.Q.fcall(function() {

        ASSERT.equal(typeof state["pio"].hostname, "string", "'state[pio].hostname' must be set!");

        var records = pio.API.DEEPCOPY(pio.getConfig("config")["pio.dns"].records);
        if (!records) {
            return;
        }

        if (ready) {
            response.status = "ready";
            return;
        }

        function lookup(name) {
            return pio.API.Q.denodeify(DNS.resolve4)(name).fail(function(err) {
                console.error("Warning: Error looking up hostname '" + name + "':", err.stack);
                return [];
            });
        }

        return lookup("a.domain.that.will.never.resolve.so.we.can.determine.default.ip.com").then(function(ips) {

            var defaultIP = ips[0] || null;
            function normalizeIPs(ips) {
                return ips.filter(function(ip) {
                    if (ip == defaultIP) return false;
                    return true;
                });
            }

            var all = [];
            records = Object.keys(records).map(function(name) {
                response.declared[name] = records[name];
                all.push(lookup(name).then(function(ips) {
                    response.resolving[name] = normalizeIPs(ips);
                }));                
                return {
                    domain: records[name].domain,
                    type: records[name].type,
                    name: name,
                    data: records[name].data
                };
            });
            return Q.all(all).then(function() {
                // Based on gathered info summarize the status.
                var diff = 0;
                for (var name in response.declared) {
                    diff += 1;
                    if (
                        state["pio.vm"].ip &&
                        response.resolving[name].length > 0 &&
                        response.resolving[name].indexOf(state["pio.vm"].ip) >= 0
                    ) {
                        diff -= 1;
                    }
                }
                if (diff === 0) {
                    ready = true;
                    response.status = "ready";
                } else {
                    response.required = false;
                    response.status = "pending";
                }
            }).then(function() {
                if (response.status === "ready") {
                    return;
                }

                // Check if hostname points to our VM so we can recover missing IP address.

                function isOurs() {
                    var deferred = Q.defer();
                    var url = "http://" + state["pio"].hostname + ":" + state["pio.services"].services["pio.server"].descriptor.env.PORT + "/.instance-id/" + state["pio"].instanceId;
                    REQUEST({
                        method: "POST",
                        url: url,
                        timeout: 1 * 1000
                    }, function(err, res, body) {
                        if (err) {
                            var message = [
                                "Error while checking if instance is ours by calling '" + url + "'.",
                                "Hostname is likely not resolving to the IP of our server!",
                                "To see what the hostname resolves to use: http://cachecheck.opendns.com/"
                            ].join("\n").red;
                            if (err.code === "ESOCKETTIMEDOUT") {
                                console.error("Warning: TIMEOUT " + message, err.stack);
                            } else {
                                console.error("Warning: " + message, err.stack);
                            }
                            return deferred.resolve(false);
                        }
                        if (res.statusCode === 204) {
                            return deferred.resolve(true);
                        }
                        return deferred.resolve(false);
                    });
                    return deferred.promise;
                }

                return isOurs().then(function(isOurs) {
                    if (isOurs) {
                        console.log("Hostname '" + state["pio"].hostname + "' is resolving to our instance.");
                        if (!response.resolving[state["pio"].hostname]) {
                            throw new Error("Could not find IP for resolved hostname '" + state["pio"].hostname + "'! The hostname must be declared in config[pio.dns].records");
                        }
                        var ip = response.resolving[state["pio"].hostname][0];

                        if (state["pio.vm"].ip) {
                            if (ip !== state["pio.vm"].ip) {
                                console.log(("Looks like hostname '" + state["pio"].hostname + "' is resolving to '" + ip + "' while cached runtime IP is '" + state["pio.vm"].ip + "'. You should never get here.").red);
                            }
                            response.status == "pending";
                            return;
                        }

                        console.log(("Recording VM IP '" + ip + "' for future use.").magenta);

                        return pio._setRuntimeConfig({
                            config: {
                                "pio.vm": {
                                    ip: ip
                                }
                            }
                        }).then(function() {

                            response.status = "repeat";
                            return;
                        });
                    }
                });

            }).then(function() {
                if (response.status === "ready" || response.status === "repeat") {
                    return;
                }
                if (!state["pio.vm"].ip) {
                    response.status = "repeat";
                    return;
                }

                try {
                    var re = new RegExp("\\n" + state["pio.vm"].ip + "\\s+" + state["pio"].hostname + "\\s*\\n");
                    if (re.test(pio.API.FS.readFileSync("/etc/hosts", "utf8"))) {
                        console.log(("WARNING: Found entry related to hostname '" + state["pio"].hostname + "' in '/etc/hosts'!").red);

                        response.status = "ready";
                        return;
                    }
                } catch(err) {
                    // TODO: Log error in verbose mode.
                    console.error(err.stack);
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
