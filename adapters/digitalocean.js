/*

	self.dns = {
		ensure: function(records) {
			return self._ready.promise.then(function() {
				return self._api.domainGetAll().then(function(domains) {
					var recordsByDomainId = {};
					var done = Q.resolve();
					records.forEach(function(record) {
						var domainId = null;
						domains.forEach(function(domain) {
							if (domainId) return;
							if (
								record.domain === domain.name ||
								record.domain.substring(record.domain.length-domain.name.length-1) === "." + domain.name
							) {
								domainId = domain.id;
								record.name = record.name.replace(new RegExp("\\." + domain.name + "$"), "");
							}
						});
						if (!domainId) {
							throw new Error("Unable to determine `domainId` for domain `" + record.domain + "`. Looks like top-level DNS record for the domain is not provisioned!");
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
											if (record.data === existingRecord.data + ".") {
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
												createRecord.data + ".",
												{}
											);
										}
										console.log(("Creating DNS record: " + JSON.stringify(createRecord)).magenta);
										return self._api.domainRecordNew(
											domainId,
											createRecord.type,
											createRecord.data + ".",
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
			});
		}
	};

*/
