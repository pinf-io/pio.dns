
const ASSERT = require("assert");
const CRYPTO = require("crypto");
const Q = require("q");
const DIGIO = require("digitalocean-api");
const DEEPMERGE = require("deepmerge");
const WAITFOR = require("waitfor");

// @see https://developers.digitalocean.com/
// @see https://github.com/enzy/digitalocean-api


var adapter = exports.adapter = function(settings) {

	var self = this;

	self._settings = settings;

	ASSERT.equal(typeof self._settings.clientId, "string");
	ASSERT.equal(typeof self._settings.apiKey, "string");

	var api = new DIGIO(self._settings.clientId, self._settings.apiKey);
	self._api = {};
	for (var name in api) {
		if (typeof api[name] === "function") {
			(function inject(name) {
				self._api[name] = function() {
					var args = Array.prototype.slice.call(arguments, 0);
					return Q.nbind(api[name], api).apply(api, args);
				}
			})(name);
		}
	}
}

adapter.prototype.ensure = function(records) {
	var self = this;
	return self._api.domainGetAll().then(function(domains) {
		var recordsByDomainId = {};
		var done = Q.resolve();
		records.forEach(function(record) {
			var domainId = null;
			domains.forEach(function(domain) {
				if (domain.error) {
					console.error("DNS error for '" + domain.name + "':", domain.error);
				}
				if (domain.zone_file_with_error) {
					console.error("DNS zone file error for '" + domain.name + "':", domain.zone_file_with_error);
				}
				if (domainId) return;
				if (record.domain === domain.name) {
					domainId = domain.id;
					record.name = record.name.replace(new RegExp("\\." + domain.name + "$"), "");
					if (record.type === "A" && record.domain == record.name) {
						record.name = "@";
					}				
					if (record.type === "CNAME") {
						record.data += ".";
					}
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
				return self._api.domainRecordGetAll(domainId).then(function(existingRecords) {
					var done = Q.resolve();
					recordsByDomainId[domainId].filter(function(record) {
						return (existingRecords.filter(function(existingRecord) {
							if (
								record.type === existingRecord.record_type &&
								record.name === existingRecord.name
							) {
								if (record.data === existingRecord.data) {
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
								return self._api.domainRecordEdit(
									domainId,
									createRecord._needsUpdate,
									createRecord.type,
									createRecord.data,
									{}
								);
							}
							console.log(("Creating DNS record: " + JSON.stringify(createRecord)).magenta);
							return self._api.domainRecordNew(
								domainId,
								createRecord.type,
								createRecord.data,
								{
									name: createRecord.name
								}
							);
						});
					});
					return done;
				});
			});
		});
		return done;
	});
}
