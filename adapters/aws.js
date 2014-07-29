
const ASSERT = require("assert");
const CRYPTO = require("crypto");
const Q = require("q");
const REQUEST = require("request");
const AWS = require("aws-sdk");

// http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/frames.html

var adapter = exports.adapter = function(settings) {

	var self = this;

	self._settings = settings;

	ASSERT.equal(typeof self._settings.accessKeyId, "string");
	ASSERT.equal(typeof self._settings.secretAccessKey, "string");

    var awsConfig = new AWS.Config({
		accessKeyId: self._settings.accessKeyId,
		secretAccessKey: self._settings.secretAccessKey
    });

	self._api = {
		route53: new AWS.Route53(awsConfig),
		callAll: function(method, params, property) {
			if (!params.MaxItems) {
				params.MaxItems = "100";
			}
			var items = [];
			function fetch(_params) {
				for (var name in _params) {
					params[name] = _params[name];
				}
				return Q.nbind(self._api.route53[method], self._api.route53)(params).then(function(response) {
					if (response[property]) {
						items = items.concat(response[property]);
					}
					if (method === "listResourceRecordSets") {
						if (response.IsTruncated) {
							return fetch({
								StartRecordName: response.NextRecordName,
								StartRecordType: response.NextRecordType
							});
						}
					}
					return;
				});
			}
			return fetch({}).then(function() {
				return items;
			});
		}
	};

	self._ready = Q.defer();
	self._ready.resolve();
}

adapter.prototype.ensure = function(records) {
	var self = this;

	return self._ready.promise.then(function() {
		// @see http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/Route53.html#listHostedZones-property
		return self._api.callAll("listHostedZones", {}, "HostedZones").then(function(zones) {

			var recordsByDomainId = {};
			if (
				zones &&
				zones.length > 0
			) {
				records.forEach(function(record) {
					var domainId = null;
					zones.forEach(function(domain) {
						if (domainId) return;
						domain.Name = domain.Name.replace(/\.$/, "");
						if (
							record.domain === domain.Name ||
							record.domain.substring(record.domain.length-domain.Name.length-1) === "." + domain.Name
						) {
							domainId = domain.Id;
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
			}

			var done = Q.resolve();
			// TODO: Parallelize all these calls.
			Object.keys(recordsByDomainId).forEach(function(domainId) {
				done = Q.when(done, function() {

					return self._api.callAll("listResourceRecordSets", {
						HostedZoneId: domainId
					}, "ResourceRecordSets").then(function(existingRecords) {
						var done = Q.resolve();
						recordsByDomainId[domainId].filter(function(record) {
							return (existingRecords.filter(function(existingRecord) {
								if (
									record.type === existingRecord.Type &&
									record.name === existingRecord.Name.replace(/\.$/, "").replace(/\\052/g, "*")
								) {
									if (
										existingRecord.ResourceRecords &&
										existingRecord.ResourceRecords[0] &&
										record.data === existingRecord.ResourceRecords[0].Value
									) {
										return true;
									}
									record._needsUpdate = existingRecord.Name;
								};
								return false;
							}).length === 0);
						}).forEach(function(createRecord) {
							done = Q.when(done, function() {
								if (createRecord._needsUpdate) {
									console.log(("Updating DNS record: " + JSON.stringify(createRecord)).magenta);
									return Q.nbind(self._api.route53.changeResourceRecordSets, self._api.route53)({
										HostedZoneId: domainId,
										ChangeBatch: {
											// TODO: Add user info.
											Comment: "automatically updated by pio dev tooling",
											Changes: [
												{
													"Action": "UPSERT",
													"ResourceRecordSet": {
														Name: createRecord.name.replace(/\*/g, "\\052") + ".",
														Type: createRecord.type,
														TTL: 300,
														ResourceRecords: [
															{
																Value: createRecord.data
															}
														]
													}
												}
											]
										}
									});
								}
								console.log(("Creating DNS record: " + JSON.stringify(createRecord)).magenta);
								return Q.nbind(self._api.route53.changeResourceRecordSets, self._api.route53)({
									HostedZoneId: domainId,
									ChangeBatch: {
										// TODO: Add user info.
										Comment: "automatically created by pio dev tooling",
										Changes: [
											{
												"Action": "CREATE",
												"ResourceRecordSet": {
													Name: createRecord.name.replace(/\*/g, "\\052") + ".",
													Type: createRecord.type,
													TTL: 300,
													ResourceRecords: [
														{
															Value: createRecord.data
														}
													]
												}
											}
										]
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

