
const ASSERT = require("assert");
const CRYPTO = require("crypto");
const Q = require("q");
const REQUEST = require("request");

// @see http://ultradns.com
// @see https://portal.ultradns.com/static/docs/REST-API_User_Guide.pdf


var adapter = exports.adapter = function(settings) {

	var self = this;

	self._settings = settings;

	ASSERT.equal(typeof self._settings.username, "string");
	ASSERT.equal(typeof self._settings.password, "string");

	function ensureToken () {
		if (ensureToken.accessToken) {
			return Q.resolve(ensureToken.accessToken);
		}
		var deferred = Q.defer();
		REQUEST({
			method: "POST",
			url: "https://restapi.ultradns.com/v1/authorization/token",
			form: {
				grant_type: "password",
				username: self._settings.username,
				password: self._settings.password
			}
		}, function(err, res, data) {
			if (err) return deferred.reject(err);
			if (!data) {
				return deferred.reject(new Error("Error authorizing: no data returned"));
			}
			try {
				data = JSON.parse(data);
			} catch (err) {
				return deferred.reject(new Error("Error '" + err.stack + "' parsing response: " + data));
			}
			return deferred.resolve((ensureToken.accessToken = data.accessToken));
		});
		return deferred.promise;
	}

	self._api = {
		call: function(method, path, payload) {
			return ensureToken().then(function (accessToken) {
				var deferred = Q.defer();
				REQUEST({
					method: method,
					url: "https://restapi.ultradns.com/v1" + path,
					json: (typeof payload === "string"),
					body: (typeof payload === "string" && JSON.parse(payload)) || null,
					form: (typeof payload !== "string" && payload) || null,
					headers: {
						"Authorization": "Bearer " + accessToken
					}
				}, function(err, res, data) {
					if (err) return deferred.reject(err);
					if (!data) {
						return deferred.reject(new Error("Error calling ultradns endpoint '" + path + "': no data returned"));
					}
					if (typeof data === "string") {
						try {
							data = JSON.parse(data);
						} catch (err) {
							return deferred.reject(new Error("Error '" + err.stack + "' parsing response: " + data));
						}
					}
					if (data.errorCode) {
						return deferred.reject(new Error("Got error '" + data.errorMessage + "' ('" + data.errorCode + "') from ultradns while calling endpoint '" + path + "'"));
					}
					if (Array.isArray(data) && data[0].errorCode) {
						data = data.shift();
						return deferred.reject(new Error("Got error '" + data.errorMessage + "' ('" + data.errorCode + "') from ultradns while calling endpoint '" + path + "'"));
					}
					if (data.resultInfo) {
						if (data.resultInfo.totalCount > data.resultInfo.returnedCount) {
							console.error("data", JSON.stringify(data, null, 4));
							throw new Error("There are more pages of results but there is no code to fetch them!");
						}
					}
					return deferred.resolve(data);
				});
				return deferred.promise;
			});
		}
	}

	self._ready = Q.defer();
	self._ready.resolve();
}

adapter.prototype.ensure = function(records) {
	var self = this;
	return self._ready.promise.then(function() {
		return self._api.call("GET", "/zones").then(function(domains) {
			var recordsByDomainId = {};
			var done = Q.resolve();
			records.forEach(function(record) {
				var domainId = null;
				domains.zones.forEach(function(domain) {
					if (domainId) return;
					domain = domain.properties;
					if ((record.domain + ".") === domain.name || (record.domain.substring(record.domain.length-domain.name.length-1) + ".") === "." + domain.name) {
						domainId = domain.name;
						if (record.type === "CNAME") {
							if (new RegExp("\\." + record.domain + "$").test(record.data)) {
								record.data = record.data.replace(new RegExp("\\." + record.domain + "$"), "");
							} else {
								record.data += ".";
							}
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

					// @see https://github.com/ultradns/Coelacanth - DNS JSON Spec

					return self._api.call("GET", "/zones/" + domainId + "/rrsets").then(function(existingRecords) {
						var done = Q.resolve();
						recordsByDomainId[domainId].filter(function(record) {
							return (existingRecords.rrSets.filter(function(existingRecord) {
								if (
									existingRecord.rrtype.substring(0, record.type.length) === record.type &&
									(record.name + ".") === existingRecord.ownerName
								) {
									if (record.data === existingRecord.rdata[0]) {
										return true;
									}
									if (record.type === "CNAME") {
										if ((record.data + "." + record.domain + ".") === existingRecord.rdata[0]) {
											return true;
										}
									}
									record._needsUpdate = existingRecord.ownerName;
								};
								return false;
							}).length === 0);
						}).forEach(function(createRecord) {
							done = Q.when(done, function() {
								if (createRecord._needsUpdate) {
									console.log(("Updating DNS record: " + JSON.stringify(createRecord)).magenta);
									return self._api.call("PATCH", "/zones/" + domainId + "/rrsets/" + createRecord.type + "/" + createRecord._needsUpdate, JSON.stringify({
										"rdata": [
											createRecord.data
										]
									}));
								}
								console.log(("Creating DNS record: " + JSON.stringify(createRecord)).magenta);
								return self._api.call("POST", "/zones/" + domainId + "/rrsets/" + createRecord.type + "/" + createRecord.name + ".", JSON.stringify({
									"ttl": 900,
									"rdata": [
										createRecord.data
									]
								}));
							});
						});
						return done;
					});
				});
			});
			return done;
		});


		/*
		return Q.denodeify(function(callback) {
			var payload = [
				'<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v01="http://webservice.api.ultra.neustar.com/v01/" xmlns:v011="http://schema.ultraservice.neustar.com/v01/">',
					'<soapenv:Header>',
						'<wsse:Security soapenv:mustUnderstand="1" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">',
							'<wsse:UsernameToken wsu:Id="UsernameToken-16318950" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">',
								'<wsse:Username>' + self._settings.username + '</wsse:Username>',
								'<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wssusername-token-profile-1.0#PasswordText">' + self._settings.password + '</wsse:Password>',
							'</wsse:UsernameToken>',
						'</wsse:Security>',
					'</soapenv:Header>',
					'<soapenv:Body>',
						'<v01:getNeustarNetworkStatus/>',
					'</soapenv:Body>',
				'</soapenv:Envelope>'
			].join("");
		console.log("make request", payload);
			return REQUEST({
				method: "POST",
				url: "https://test-restapi.ultradns.com/",
				body: payload,
				headers: {
					"Accept": "text/xml",
					"Content-Type": "text/xml;charset=UTF-8",
					"Content-Length": payload.length
				},
				rejectUnauthorized: false
			}, function(err, res, body) {
				if (err) return callback(err);

		console.log("body", body);


				throw "STOP";
			});
		})();
		*/
	});
}

