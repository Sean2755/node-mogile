var	url = require('url'),
	http = require('http'),
	fs = require('fs'),
	noop = function() {};

/**
 * Constructor
 *
 * @param {Mogile} mogile Instance of the Mogile class
 * @param {String} name The domain name
 */
var Domain = function(mogile, name)
{
	this.mogile = mogile;
	this.name = name;
}

/**
 * Factory method
 *
 * Returns a new instance of the Domain class
 *
 * @param {Mogile} mogile Instance of the Mogile class
 * @param {String} name The domain name
 * @return {Domain}
 */
Domain.factory = function(mogile, name)
{
	return new Domain(mogile, name);
}

/**
 * Returns the paths for a given key
 *
 * @param {String} key The storage key
 * @param {Boolean} noverify Don't have MogileFS check that the file exists
 * @param {Function} callback Function that receives an array of paths for the given storage key
 * @return {Boolean}
 */
Domain.prototype.getPaths = function(key, noverify, callback)
{
	callback = callback || noop;
	var args = {
		key: key,
		noverify: ((noverify) ? '1' : '0')
	};
	this.mogile.send(this.name, 'GET_PATHS', args, function(err, response) {
		if (err) {
			return callback(err);
		}
		var paths = [];
		for(var i = 1; i <= response['paths']; i++) {
			paths.push(response['path' + i]);
		}
		callback(null, paths);
	});
	
	return true;
}

/**
 * Deletes the file with the given key
 *
 * @param {String} key The storage key
 * @param {String} storage_class Optional. The storage class. Only required when using transactions
 * @param {Function} callback Function to call when the delete is complete
 * @return {Boolean}
 */
Domain.prototype.del = function(key, storage_class, callback)
{
	if (typeof storage_class == 'function') {
		callback = storage_class;
		storage_class = null;
	}
	callback = callback || noop;
	var args = {
		"key": key,
		"class": storage_class
	};
	this.mogile.send(this.name, 'DELETE', args, function(err, response) {
		if (err) {
			return callback(err);
		}
		callback();
	});
}

/**
 * Renames a file from one key to another
 *
 * @param {String} from_key The original key
 * @param {String} to_key The new key
 * @param {Function} callback Function to call when the rename is complete
 * @return {Boolean}
 */
Domain.prototype.rename = function(from_key, to_key, callback)
{
	callback = callback || noop;
	var args = {
		"from_key": from_key,
		"to_key": to_key
	};
	this.mogile.send(this.name, 'RENAME', args, function(err, response) {
		if (err) {
			return callback(err);
		}
		callback();
	});
}

/**
 * Gets the file with the given key, and writes it to a local file
 *
 * @param {String} key The storage key
 * @param {String} local The location to write the file to
 * @param {Function} callback Function to call when the local file has been written. Receives the number of bytes read.
 * @return {Boolean}
 */
Domain.prototype.getFile = function(key, local, callback)
{
	callback = callback || noop;
	var bytes_written = 0;
	var paused = false;
	var response = null;
	
	this.getPaths(key, 0, function(err, paths) {
		if (err) {
			return callback(err);
		}
		
		var write_options = {
			flags: 'w+',
			mode: 0666
		};
		var stream = fs.createWriteStream(local, write_options);
		stream.on('open', function(fd) {
			var url_parts = url.parse(paths[0]);
			var get_options = {
				host: url_parts.hostname,
				port: url_parts.port,
				path: url_parts.pathname
			};
			var get = http.get(get_options, function(res) {
				response = res;
				res.on('data', function(data) {
					bytes_written += data.length;
					var drained = stream.write(data);
					if (!drained) {
						res.pause();
						paused = true;
					}
				});
				res.on('end', function() {
					var finished = function() {
						if (paused) {
							process.nextTick(finished);
						} else {
							stream.end();
							return callback(null, bytes_written);
						}
					}
					finished();
				});
			});
			get.on('error', function(e) {
				stream.end();
				return callback(e);
			});
		});
		stream.on('error', function(e) {
			return callback(e);
		});
		stream.on('drain', function() {
			if (paused) {
				if (!response.complete) response.resume();
				paused = false;
			}
		});
	});
	
	return true;
}

/**
 * Stores a file with the given key, in the given storage class, from the local file
 *
 * @param {String} key The storage key to save the file as
 * @param {String} storage_class The storage class
 * @param {String} local The local file to read from
 * @param {Function} callback Function to call when the operation is complete. Receives the number of bytes stored.
 * @return {Boolean}
 */
Domain.prototype.storeFile = function(key, storage_class, local, callback)
{
	callback = callback || noop;
	var $this = this;
	var args = {
		"key": key,
		"class": storage_class
	};
	$this.mogile.send($this.name, 'CREATE_OPEN', args, function(err, response) {
		if (err) {
			return callback(err);
		}
		
		// Typical response: { devid: '95', fid: '504917521', path: 'http://127.0.0.1:7500/dev95/0/504/917/0504917521.fid' }
		fs.stat(local, function(err, stat) {
			if (err) {
				return callback(err);
			}

			var path = url.parse(response.path);
			var options = {
				"host": path.hostname,
				"port": parseFloat(path.port),
				"path": path.pathname,
				"method": "PUT",
				"headers": {
					"Content-Length": stat.size
				}
			};
			
			var request = http.request(options);
			request.on('error', function(err) {
				return callback(err);
			});
			
			var stream = fs.createReadStream(local, { bufferSize: 512 * 1024 });
			stream.pipe(request);
			stream.on('end', function() {
				request.end();
				var args = {
					"key": key,
					"class": storage_class,
					"devid": response.devid,
					"fid": response.fid,
					"path": response.path
				};
				$this.mogile.send($this.name, 'CREATE_CLOSE', args, function(err, response) {
					if (err) {
						return callback(err);
					}
					callback(null, stat.size);
				});
			});
		});
	});
}

/**
 * listkey is search keys option
 *
 * @param {String} prefix  Key prefix
 * @param {String} lastKey Optional. Last key
 * @param {String} limit Optional. Maximum number of keys to return
 * @param {Function} callback Function to call when the listkey is complete
 * @return {Boolean}
 */

Domain.prototype.get_keys = function(prefix, lastKey, limit, callback)
{
	callback = callback || noop;
	lastKey = lastKey || 0 ;
	limit   = limit || 100;
	
	let key_list = [];

	var args = {
		'prefix': prefix,
		'after' : lastKey,
		'limit' : limit
	};
	this.mogile.send(this.name, 'list_keys', args, function(err,response) {
		if (err) {
			return callback(err,response);
		}

		for(var i = 1; i < parseInt(response['key_count'])+1; i++) {
			key_list.push(response[`key_${i}` ]);		 
  		 }
		callback(err, key_list);
	});
}

// Export the Domain class
module.exports = Domain;