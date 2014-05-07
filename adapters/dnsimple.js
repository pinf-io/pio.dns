
const ASSERT = require("assert");
const CRYPTO = require("crypto");
const Q = require("q");
const REQUEST = require("request");

// @see https://dnsimple.com/domains
// @see https://github.com/fvdm/nodejs-dnsimple


var adapter = exports.adapter = function(settings) {

	var self = this;

	self._settings = settings;

	ASSERT.equal(typeof self._settings.email, "string");
	ASSERT.equal(typeof self._settings.token, "string");

	self._api = {
		call: function(method, path, payload) {
			var deferred = Q.defer();
			REQUEST({
				method: method,
				url: "https://api.dnsimple.com/v1/" + path,
				json: true,
				body: payload || null,
				headers: {
					"X-DNSimple-Token": self._settings.email + ":" + self._settings.token
				}
			}, function(err, res, data) {
				if (err) return deferred.reject(err);
				return deferred.resolve(data);
			});
			return deferred.promise;
		}
	}

	self._ready = Q.defer();
	self._ready.resolve();
}

adapter.prototype.ensure = function(records) {
	var self = this;
	return self._ready.promise.then(function() {
		return self._api.call("GET", "/domains").then(function(domains) {
			var recordsByDomainId = {};
			var done = Q.resolve();
			records.forEach(function(record) {
				var domainId = null;
				domains.forEach(function(domain) {
					if (domainId) return;
					domain = domain.domain;
					if (record.domain === domain.name || record.domain.substring(record.domain.length-domain.name.length-1) === "." + domain.name) {
						domainId = domain.id;
						record.name = record.name.replace(new RegExp("\\." + domain.name + "$"), "");
					}
				});
				if (!domainId) {
					throw new Error("Unable to find domain `" + record.domain + "`. Looks like top-level DNS record for the domain is not provisioned!");
				}
				if (!recordsByDomainId[domainId]) {
					recordsByDomainId[domainId] = [];
				}
				recordsByDomainId[domainId].push(record);
			});
			// TODO: Parallelize all these calls.
			Object.keys(recordsByDomainId).forEach(function(domainId) {
				done = Q.when(done, function() {
					return self._api.call("GET", "/domains/" + domainId + "/records").then(function(existingRecords) {
						var done = Q.resolve();
						recordsByDomainId[domainId].map(function(record) {
							if (record.type === "A") {
								record.name = "";
							}
							return record;
						}).filter(function(record) {
							return (existingRecords.filter(function(existingRecord) {
								existingRecord = existingRecord.record;
								if (
									record.type === existingRecord.record_type &&
									record.name === existingRecord.name
								) {
									if (record.data === existingRecord.content) {
										return true;
									}
									record._needsUpdate = existingRecord.id;
								};
								return false;
							}).length === 0);
						}).forEach(function(createRecord) {
							done = Q.when(done, function() {
								if (createRecord._needsUpdate) {
									console.log(("Updating DNS record: " + JSON.stringify(createRecord)).magenta);
									return self._api.call("PUT", "/domains/" + domainId + "/records/" + createRecord._needsUpdate, {
										record: {
											name: createRecord.name,
											record_type: createRecord.type,
											content: createRecord.data
										}
									});
								}
								console.log(("Creating DNS record: " + JSON.stringify(createRecord)).magenta);
								return self._api.call("POST", "/domains/" + domainId + "/records", {
									record: {
										name: createRecord.name,
										record_type: createRecord.type,
										content: createRecord.data
									}
								});
							});
						});
						return done;
					});
				});
			});
			return done;
		});
	});
}

