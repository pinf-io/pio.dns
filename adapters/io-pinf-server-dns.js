
const ASSERT = require("assert");
const CRYPTO = require("crypto");
const Q = require("q");
const REQUEST = require("request");


var adapter = exports.adapter = function(settings) {

	var self = this;

	self._settings = settings;

	ASSERT.equal(typeof self._settings.host, "string");
	ASSERT.equal(typeof self._settings.profile, "string");
	ASSERT.equal(typeof self._settings.token, "string");

	self._api = {
		call: function(method, path, payload) {
			var deferred = Q.defer();
			var url = "http://" + self._settings.host + "/" + path;
			REQUEST({
				method: method,
				url: url,
				json: true,
				body: payload || null,
				headers: {
					"token": self._settings.token
				}
			}, function(err, res, data) {
				if (err) return deferred.reject(err);
				if (res.statusCode !== 200) {
					return deferred.reject(new Error("Got status " + res.statusCode + " while calling: " + url));
				}
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
		return self._api.call("POST", "ensure", {
			profile: self._settings.profile,
			records: records
		}).then(function(result) {
			// Success.
		});
	});
}

