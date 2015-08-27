/*!
 * Copyright 2014 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*!
 * @module storage/file
 */

'use strict';

var bufferEqual = require('buffer-equal');
var concat = require('concat-stream');
var ConfigStore = require('configstore');
var crypto = require('crypto');
var duplexify = require('duplexify');
var format = require('string-format-obj');
var fs = require('fs');
var hashStreamValidation = require('hash-stream-validation');
var is = require('is');
var once = require('once');
var pumpify = require('pumpify');
var request = require('request').defaults({
  pool: {
    maxSockets: Infinity
  }
});
var streamEvents = require('stream-events');
var through = require('through2');
var zlib = require('zlib');

/**
 * @type {module:storage/acl}
 * @private
 */
var Acl = require('./acl.js');

/**
 * @type {module:common/util}
 * @private
 */
var util = require('../common/util.js');

/**
 * @const {string}
 * @private
 */
var STORAGE_UPLOAD_BASE_URL = 'https://www.googleapis.com/upload/storage/v1/b';

/*! Developer Documentation
 *
 * @param {module:storage/bucket} bucket - The Bucket instance this file is
 *     attached to.
 * @param {string} name - The name of the remote file.
 * @param {object=} options - Configuration object.
 * @param {number} options.generation - Generation to scope the file to.
 */
/**
 * A File object is created from your Bucket object using
 * {module:storage/bucket#file}.
 *
 * @alias module:storage/file
 * @constructor
 */
function File(bucket, name, options) {
  if (!name) {
    throw Error('A file name must be specified.');
  }

  options = options || {};

  this.bucket = bucket;
  this.generation = parseInt(options.generation, 10);
  this.makeReq_ = bucket.makeReq_.bind(bucket);
  this.metadata = {};

  Object.defineProperty(this, 'name', {
    enumerable: true,
    value: name
  });

  /**
   * Google Cloud Storage uses access control lists (ACLs) to manage object and
   * bucket access. ACLs are the mechanism you use to share objects with other
   * users and allow other users to access your buckets and objects.
   *
   * An ACL consists of one or more entries, where each entry grants permissions
   * to an entity. Permissions define the actions that can be performed against
   * an object or bucket (for example, `READ` or `WRITE`); the entity defines
   * who the permission applies to (for example, a specific user or group of
   * users).
   *
   * The `acl` object on a File instance provides methods to get you a list of
   * the ACLs defined on your bucket, as well as set, update, and delete them.
   *
   * @resource [About Access Control lists]{@link http://goo.gl/6qBBPO}
   *
   * @mixes module:storage/acl
   *
   * @example
   * //-
   * // Make a file publicly readable.
   * //-
   * var gcs = gcloud.storage({
   *   projectId: 'grape-spaceship-123'
   * });
   *
   * var myFile = gcs.bucket('my-bucket').file('my-file');
   *
   *  myFile.acl.add({
   *   entity: 'allUsers',
   *   role: gcs.acl.READER_ROLE
   * }, function(err, aclObject) {});
   */
  this.acl = new Acl({
    makeReq: this.makeReq_,
    pathPrefix: '/o/' + encodeURIComponent(this.name) + '/acl'
  });
}

/**
 * Copy this file to another file. By default, this will copy the file to the
 * same bucket, but you can choose to copy it to another Bucket by providing
 * either a Bucket or File object.
 *
 * @resource [Objects: copy API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objects/copy}
 *
 * @throws {Error} If the destination file is not provided.
 *
 * @param {string|module:storage/bucket|module:storage/file} destination -
 *     Destination file.
 * @param {function=} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 * @param {module:storage/file} callback.copiedFile - The copied File.
 * @param {object} callback.apiResponse - The full API response.
 *
 * @example
 * //-
 * // You can pass in a variety of types for the destination.
 * //
 * // For all of the below examples, assume we are working with the following
 * // Bucket and File objects.
 * //-
 * var bucket = gcs.bucket('my-bucket');
 * var file = bucket.file('my-image.png');
 *
 * //-
 * // If you pass in a string for the destination, the file is copied to its
 * // current bucket, under the new name provided.
 * //-
 * file.copy('my-image-copy.png', function(err, copiedFile, apiResponse) {
 *   // `my-bucket` now contains:
 *   // - "my-image.png"
 *   // - "my-image-copy.png"
 *
 *   // `copiedFile` is an instance of a File object that refers to your new
 *   // file.
 * });
 *
 * //-
 * // If you pass in a Bucket object, the file will be copied to that bucket
 * // using the same name.
 * //-
 * var anotherBucket = gcs.bucket('another-bucket');
 * file.copy(anotherBucket, function(err, copiedFile, apiResponse) {
 *   // `my-bucket` still contains:
 *   // - "my-image.png"
 *   //
 *   // `another-bucket` now contains:
 *   // - "my-image.png"
 *
 *   // `copiedFile` is an instance of a File object that refers to your new
 *   // file.
 * });
 *
 * //-
 * // If you pass in a File object, you have complete control over the new
 * // bucket and filename.
 * //-
 * var anotherFile = anotherBucket.file('my-awesome-image.png');
 * file.copy(anotherFile, function(err, copiedFile, apiResponse) {
 *   // `my-bucket` still contains:
 *   // - "my-image.png"
 *   //
 *   // `another-bucket` now contains:
 *   // - "my-awesome-image.png"
 *
 *   // Note:
 *   // The `copiedFile` parameter is equal to `anotherFile`.
 * });
 */
File.prototype.copy = function(destination, callback) {
  var noDestinationError = new Error('Destination file should have a name.');

  if (!destination) {
    throw noDestinationError;
  }

  callback = callback || util.noop;

  var destBucket;
  var destName;
  var newFile;

  if (is.string(destination)) {
    destBucket = this.bucket;
    destName = destination;
  } else if (destination.constructor &&
        destination.constructor.name === 'Bucket') {
    destBucket = destination;
    destName = this.name;
  } else if (destination instanceof File) {
    destBucket = destination.bucket;
    destName = destination.name;
    newFile = destination;
  } else {
    throw noDestinationError;
  }

  var path = format('/o/{srcName}/copyTo/b/{destBucket}/o/{destName}', {
    srcName: encodeURIComponent(this.name),
    destBucket: destBucket.name,
    destName: encodeURIComponent(destName)
  });

  var query = {};

  if (this.generation) {
    query.sourceGeneration = this.generation;
  }

  this.makeReq_('POST', path, query, null, function(err, resp) {
    if (err) {
      callback(err, null, resp);
      return;
    }

    callback(null, newFile || destBucket.file(destName), resp);
  });
};

/**
 * Move this file to another location. By default, this will move the file to
 * the same bucket, but you can choose to move it to another Bucket by providing
 * either a Bucket or File object.
 *
 * **Warning**:
 * There is currently no atomic `move` method in the Google Cloud Storage API,
 * so this method is a composition of {module:storage/file#copy} (to the new
 * location) and {module:storage/file#delete} (from the old location). While
 * unlikely, it is possible that an error returned to your callback could be
 * triggered from either one of these API calls failing, which could leave a
 * duplicate file lingering.
 *
 * @resource [Objects: copy API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objects/copy}
 *
 * @throws {Error} If the destination file is not provided.
 *
 * @param {string|module:storage/bucket|module:storage/file} destination -
 *     Destination file.
 * @param {function=} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 * @param {module:storage/file} callback.destinationFile - The destination File.
 * @param {object} callback.apiResponse - The full API response.
 *
 * @example
 * //-
 * // You can pass in a variety of types for the destination.
 * //
 * // For all of the below examples, assume we are working with the following
 * // Bucket and File objects.
 * //-
 * var bucket = gcs.bucket('my-bucket');
 * var file = bucket.file('my-image.png');
 *
 * //-
 * // If you pass in a string for the destination, the file is moved to its
 * // current bucket, under the new name provided.
 * //-
 * file.move('my-image-new.png', function(err, destinationFile, apiResponse) {
 *   // `my-bucket` no longer contains:
 *   // - "my-image.png"
 *   // but contains instead:
 *   // - "my-image-new.png"
 *
 *   // `destinationFile` is an instance of a File object that refers to your
 *   // new file.
 * });
 *
 * //-
 * // If you pass in a Bucket object, the file will be moved to that bucket
 * // using the same name.
 * //-
 * var anotherBucket = gcs.bucket('another-bucket');
 *
 * file.move(anotherBucket, function(err, destinationFile, apiResponse) {
 *   // `my-bucket` no longer contains:
 *   // - "my-image.png"
 *   //
 *   // `another-bucket` now contains:
 *   // - "my-image.png"
 *
 *   // `destinationFile` is an instance of a File object that refers to your
 *   // new file.
 * });
 *
 * //-
 * // If you pass in a File object, you have complete control over the new
 * // bucket and filename.
 * //-
 * var anotherFile = anotherBucket.file('my-awesome-image.png');
 *
 * file.move(anotherFile, function(err, destinationFile, apiResponse) {
 *   // `my-bucket` no longer contains:
 *   // - "my-image.png"
 *   //
 *   // `another-bucket` now contains:
 *   // - "my-awesome-image.png"
 *
 *   // Note:
 *   // The `destinationFile` parameter is equal to `anotherFile`.
 * });
 */
File.prototype.move = function(destination, callback) {
  var self = this;

  callback = callback || util.noop;

  this.copy(destination, function(err, destinationFile, apiResponse) {
    if (err) {
      callback(err, null, apiResponse);
      return;
    }

    self.delete(function(err, apiResponse) {
      callback(err, destinationFile, apiResponse);
    });
  });
};

/**
 * Create a readable stream to read the contents of the remote file. It can be
 * piped to a writable stream or listened to for 'data' events to read a file's
 * contents.
 *
 * In the unlikely event there is a mismatch between what you downloaded and the
 * version in your Bucket, your error handler will receive an error with code
 * "CONTENT_DOWNLOAD_MISMATCH". If you receive this error, the best recourse is
 * to try downloading the file again.
 *
 * NOTE: Readable streams will emit the `complete` event when the file is fully
 * downloaded.
 *
 * @param {object=} options - Configuration object.
 * @param {string|boolean} options.validation - Possible values: `"md5"`,
 *     `"crc32c"`, or `false`. By default, data integrity is validated with an
 *     MD5 checksum for maximum reliability, falling back to CRC32c when an MD5
 *     hash wasn't returned from the API. CRC32c will provide better performance
 *     with less reliability. You may also choose to skip validation completely,
 *     however this is **not recommended**.
 * @param {number} options.start - A byte offset to begin the file's download
 *     from. Default is 0. NOTE: Byte ranges are inclusive; that is,
 *     `options.start = 0` and `options.end = 999` represent the first 1000
 *     bytes in a file or object. NOTE: when specifying a byte range, data
 *     integrity is not available.
 * @param {number} options.end - A byte offset to stop reading the file at.
 *     NOTE: Byte ranges are inclusive; that is, `options.start = 0` and
 *     `options.end = 999` represent the first 1000 bytes in a file or object.
 *     NOTE: when specifying a byte range, data integrity is not available.
 *
 * @example
 * //-
 * // <h4>Downloading a File</h4>
 * //
 * // The example below demonstrates how we can reference a remote file, then
 * // pipe its contents to a local file. This is effectively creating a local
 * // backup of your remote data.
 * //-
 * var fs = require('fs');
 * var myBucket = gcs.bucket('my-bucket');
 * var remoteFile = myBucket.file('image.png');
 * var localFilename = '/Users/stephen/Photos/image.png';
 *
 * remoteFile.createReadStream()
 *   .on('error', function(err) {})
 *   .on('response', function(response) {
 *     // Server connected and responded with the specified status and headers.
 *    })
 *   .on('end', function() {
 *     // The file is fully downloaded.
 *   })
 *   .pipe(fs.createWriteStream(localFilename));
 *
 * //-
 * // To limit the downloaded data to only a byte range, pass an options object.
 * //-
 * var logFile = myBucket.file('access_log');
 * logFile.createReadStream({
 *     start: 10000,
 *     end: 20000
 *   })
 *   .on('error', function(err) {})
 *   .pipe(fs.createWriteStream('/Users/stephen/logfile.txt'));
 *
 * //-
 * // To read a tail byte range, specify only `options.end` as a negative
 * // number.
 * //-
 * var logFile = myBucket.file('access_log');
 * logFile.createReadStream({
 *     end: -100
 *   })
 *   .on('error', function(err) {})
 *   .pipe(fs.createWriteStream('/Users/stephen/logfile.txt'));
 */
File.prototype.createReadStream = function(options) {
  options = options || {};

  var self = this;
  var rangeRequest = is.number(options.start) || is.number(options.end);
  var tailRequest = options.end < 0;
  var throughStream = streamEvents(through());

  var crc32c = options.validation !== false;
  var md5 = options.validation !== false;

  if (is.string(options.validation)) {
    options.validation = options.validation.toLowerCase();
    crc32c = options.validation === 'crc32c';
    md5 = options.validation === 'md5';
  }

  if (rangeRequest) {
    if (is.string(options.validation) || options.validation === true) {
      throw new Error('Cannot use validation with file ranges (start/end).');
    }
    // Range requests can't receive data integrity checks.
    crc32c = false;
    md5 = false;
  }

  // Authenticate the request, then pipe the remote API request to the stream
  // returned to the user.
  function makeRequest() {
    var reqOpts = {
      uri: format('https://storage.googleapis.com/{b}/{o}', {
        b: self.bucket.name,
        o: encodeURIComponent(self.name)
      }),
      gzip: true
    };

    if (self.generation) {
      reqOpts.qs = {
        generation: self.generation
      };
    }

    if (rangeRequest) {
      var start = is.number(options.start) ? options.start : '0';
      var end = is.number(options.end) ? options.end : '';

      reqOpts.headers = {
        Range: 'bytes=' + (tailRequest ? end : start + '-' + end)
      };
    }

    var requestStream = self.bucket.storage.makeAuthorizedRequest_(reqOpts);
    var validateStream;

    // We listen to the response event from the request stream so that we can...
    //
    //   1) Intercept any data from going to the user if an error occurred.
    //   2) Calculate the hashes from the http.IncomingMessage response stream,
    //      which will return the bytes from the source without decompressing
    //      gzip'd content. The request stream will do the decompression so the
    //      user receives the expected content.
    function onResponse(err, body, res) {
      if (err) {
        requestStream.unpipe(throughStream);
        return;
      }

      if (!rangeRequest) {
        validateStream = hashStreamValidation({
          crc32c: crc32c,
          md5: md5
        });

        res.pipe(validateStream).on('data', util.noop);
      }
    }

    // This is hooked to the `complete` event from the request stream. This is
    // our chance to validate the data and let the user know if anything went
    // wrong.
    function onComplete(err, body, res) {
      if (err) {
        throughStream.destroy(err);
        return;
      }

      if (rangeRequest) {
        return;
      }

      var hashes = {};
      res.headers['x-goog-hash'].split(',').forEach(function(hash) {
        var hashType = hash.split('=')[0].trim();
        hashes[hashType] = hash.substr(hash.indexOf('=') + 1);
      });

      var failed = true;

      if (crc32c && hashes.crc32c) {
        // We must remove the first four bytes from the returned checksum.
        // http://stackoverflow.com/questions/25096737/
        //   base64-encoding-of-crc32c-long-value
        failed = !validateStream.test('crc32c', hashes.crc32c.substr(4));
      }

      if (md5 && hashes.md5) {
        failed = !validateStream.test('md5', hashes.md5);
      }

      if (failed) {
        var mismatchError = new Error([
          'The downloaded data did not match the data from the server.',
          'To be sure the content is the same, you should download the',
          'file again.'
        ].join(' '));
        mismatchError.code = 'CONTENT_DOWNLOAD_MISMATCH';

        throughStream.destroy(mismatchError);
      }
    }

    requestStream
      .on('error', function(err) {
        throughStream.destroy(err);
      })
      .on('response', function(res) {
        throughStream.emit('response', res);
        util.handleResp(null, res, null, onResponse);
      })
      .on('complete', function(res) {
        util.handleResp(null, res, null, onComplete);
      })
      .pipe(throughStream)
      .on('error', function() {
        requestStream.abort();
        requestStream.destroy();
      });
  }

  throughStream.on('reading', makeRequest);

  return throughStream;
};

/**
 * Create a writable stream to overwrite the contents of the file in your
 * bucket.
 *
 * A File object can also be used to create files for the first time.
 *
 * Resumable uploads are automatically enabled and must be shut off explicitly
 * by setting `options.resumable` to `false`.
 *
 * NOTE: Writable streams will emit the `complete` event when the file is fully
 * uploaded.
 *
 * @resource [Upload Options (Simple or Resumable)]{@link https://cloud.google.com/storage/docs/json_api/v1/how-tos/upload#uploads}
 * @resource [Objects: insert API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objects/insert}
 *
 * @param {object=} options - Configuration object.
 * @param {boolean} options.gzip - Automatically gzip the file. This will set
 *     `options.metadata.contentEncoding` to `gzip`.
 * @param {object} options.metadata - Set the metadata for this file.
 * @param {boolean} options.resumable - Force a resumable upload. NOTE: When
 *     working with streams, the file format and size is unknown until it's
 *     completely consumed. Because of this, it's best for you to be explicit
 *     for what makes sense given your input.
 * @param {string|boolean} options.validation - Possible values: `"md5"`,
 *     `"crc32c"`, or `false`. By default, data integrity is validated with an
 *     MD5 checksum for maximum reliability. CRC32c will provide better
 *     performance with less reliability. You may also choose to skip validation
 *     completely, however this is **not recommended**.
 *
 * @example
 * //-
 * // <h4>Uploading a File</h4>
 * //
 * // Now, consider a case where we want to upload a file to your bucket. You
 * // have the option of using {module:storage/bucket#upload}, but that is just
 * // a convenience method which will do the following.
 * //-
 * var fs = require('fs');
 * var image = myBucket.file('image.png');
 *
 * fs.createReadStream('/Users/stephen/Photos/birthday-at-the-zoo/panda.jpg')
 *   .pipe(image.createWriteStream())
 *   .on('error', function(err) {})
 *   .on('finish', function() {
 *     // The file upload is complete.
 *   });
 *
 * //-
 * // <h4>Uploading a File with gzip compression</h4>
 * //-
 * var fs = require('fs');
 * var htmlFile = myBucket.file('index.html');
 *
 * fs.createReadStream('/Users/stephen/site/index.html')
 *   .pipe(htmlFile.createWriteStream({ gzip: true }))
 *   .on('error', function(err) {})
 *   .on('finish', function() {
 *     // The file upload is complete.
 *   });
 *
 * //-
 * // Downloading the file with `createReadStream` will automatically decode the
 * // file.
 * //-
 *
 * //-
 * // <h4>Uploading a File with Metadata</h4>
 * //
 * // One last case you may run into is when you want to upload a file to your
 * // bucket and set its metadata at the same time. Like above, you can use
 * // {module:storage/bucket#upload} to do this, which is just a wrapper around
 * // the following.
 * //-
 * var fs = require('fs');
 * var image = myBucket.file('image.png');
 *
 * fs.createReadStream('/Users/stephen/Photos/birthday-at-the-zoo/panda.jpg')
 *   .pipe(image.createWriteStream({
 *     metadata: {
 *       contentType: 'image/jpeg',
 *       metadata: {
 *         custom: 'metadata'
 *       }
 *     }
 *   }))
 *   .on('error', function(err) {})
 *   .on('finish', function() {
 *     // The file upload is complete.
 *   });
 */
File.prototype.createWriteStream = function(options) {
  options = options || {};

  var self = this;

  var gzip = options.gzip;

  var metadata = options.metadata || {};
  if (gzip) {
    metadata.contentEncoding = 'gzip';
  }

  var crc32c = options.validation !== false;
  var md5 = options.validation !== false;

  if (is.string(options.validation)) {
    options.validation = options.validation.toLowerCase();
    crc32c = options.validation === 'crc32c';
    md5 = options.validation === 'md5';
  }

  // Collect data as it comes in to store in a hash. This is compared to the
  // checksum value on the returned metadata from the API.
  var validateStream = hashStreamValidation({
    crc32c: crc32c,
    md5: md5
  });

  var fileWriteStream = duplexify();

  var stream = streamEvents(pumpify([
    gzip ? zlib.createGzip() : through(),
    validateStream,
    fileWriteStream
  ]));

  // Wait until we've received data to determine what upload technique to use.
  stream.on('writing', function() {
    if (options.resumable === false) {
      self.startSimpleUpload_(fileWriteStream, metadata);
    } else {
      self.startResumableUpload_(fileWriteStream, metadata);
    }
  });

  // This is to preserve the `finish` event. We wait until the request stream
  // emits "complete", as that is when we do validation of the data. After that
  // is successful, we can allow the stream to naturally finish.
  //
  // Reference for tracking when we can use a non-hack solution:
  // https://github.com/nodejs/node/pull/2314
  fileWriteStream.on('prefinish', function() {
    stream.cork();
  });

  // Compare our hashed version vs the completed upload's version.
  fileWriteStream.on('complete', function(metadata) {
    var failed = true;

    if (crc32c && metadata.crc32c) {
      // We must remove the first four bytes from the returned checksum.
      // http://stackoverflow.com/questions/25096737/
      //   base64-encoding-of-crc32c-long-value
      failed = !validateStream.test('crc32c', metadata.crc32c.substr(4));
    }

    if (md5 && metadata.md5Hash) {
      failed = !validateStream.test('md5', metadata.md5Hash);
    }

    if (failed) {
      self.delete(function(err) {
        var code;
        var message;

        if (err) {
          code = 'FILE_NO_UPLOAD_DELETE';
          message = [
            'The uploaded data did not match the data from the server. As a',
            'precaution, we attempted to delete the file, but it was not',
            'successful. To be sure the content is the same, you should try',
            'removing the file manually, then uploading the file again.',
            '\n\nThe delete attempt failed with this message:',
            '\n\n  ' + err.message
          ].join(' ');
        } else {
          code = 'FILE_NO_UPLOAD';
          message = [
            'The uploaded data did not match the data from the server. As a',
            'precaution, the file has been deleted. To be sure the content',
            'is the same, you should try uploading the file again.'
          ].join(' ');
        }

        var error = new Error(message);
        error.code = code;
        error.errors = [err];

        fileWriteStream.destroy(error);
      });

      return;
    }

    stream.uncork();
  });

  return stream;
};

/**
 * Delete the file.
 *
 * @resource [Objects: delete API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objects/delete}
 *
 * @param {function=} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 * @param {object} callback.apiResponse - The full API response.
 *
 * @example
 * file.delete(function(err, apiResponse) {});
 */
File.prototype.delete = function(callback) {
  callback = callback || util.noop;

  var path = '/o/' + encodeURIComponent(this.name);

  var query = {};

  if (this.generation) {
    query.generation = this.generation;
  }

  this.makeReq_('DELETE', path, query, null, function(err, resp) {
    if (err) {
      callback(err, resp);
      return;
    }

    callback(null, resp);
  });
};

/**
 * Convenience method to download a file into memory or to a local destination.
 *
 * @param {object=} options - Optional configuration. The arguments match those
 *     passed to {module:storage/file#createReadStream}.
 * @param {string} options.destination - Local file path to write the file's
 *     contents to.
 * @param {function} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 * @param {buffer} callback.contents - The contents of a File.
 *
 * @example
 * //-
 * // Download a file into memory. The contents will be available as the second
 * // argument in the demonstration below, `contents`.
 * //-
 * file.download(function(err, contents) {});
 *
 * //-
 * // Download a file to a local destination.
 * //-
 * file.download({
 *   destination: '/Users/stephen/Desktop/file-backup.txt'
 * }, function(err) {});
 */
File.prototype.download = function(options, callback) {
  if (is.fn(options)) {
    callback = options;
    options = {};
  }

  callback = once(callback);

  var destination = options.destination;
  delete options.destination;

  var fileStream = this.createReadStream(options);

  if (destination) {
    fileStream
      .on('error', callback)
      .pipe(fs.createWriteStream(destination))
      .on('error', callback)
      .on('finish', callback);
  } else {
    fileStream
      .on('error', callback)
      .pipe(concat(callback.bind(null, null)));
  }
};

/**
 * Get the file's metadata.
 *
 * @resource [Objects: get API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objects/get}
 *
 * @param {function=} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 * @param {object} callback.metadata - The File's metadata.
 * @param {object} callback.apiResponse - The full API response.
 *
 * @example
 * file.getMetadata(function(err, metadata, apiResponse) {});
 */
File.prototype.getMetadata = function(callback) {
  var self = this;
  callback = callback || util.noop;

  var path = '/o/' + encodeURIComponent(this.name);

  var query = {};

  if (this.generation) {
    query.generation = this.generation;
  }

  this.makeReq_('GET', path, query, null, function(err, resp) {
    if (err) {
      callback(err, null, resp);
      return;
    }

    self.metadata = resp;
    callback(null, self.metadata, resp);
  });
};

/**
 * Get a signed policy document to allow a user to upload data with a POST
 * request.
 *
 * @resource [Policy Document Reference]{@link https://cloud.google.com/storage/docs/reference-methods#policydocument}
 *
 * @throws {Error} If an expiration timestamp from the past is given.
 * @throws {Error} If options.equals has an array with less or more than two
 *     members.
 * @throws {Error} If options.startsWith has an array with less or more than two
 *     members.
 *
 * @param {object} options - Configuration object.
 * @param {object} options.expiration - Timestamp (seconds since epoch) when
 *     this policy will expire.
 * @param {array|array[]=} options.equals - Array of request parameters and
 *     their expected value (e.g. [['$<field>', '<value>']]). Values are
 *     translated into equality constraints in the conditions field of the
 *     policy document (e.g. ['eq', '$<field>', '<value>']). If only one
 *     equality condition is to be specified, options.equals can be a one-
 *     dimensional array (e.g. ['$<field>', '<value>']).
 * @param {array|array[]=} options.startsWith - Array of request parameters and
 *     their expected prefixes (e.g. [['$<field>', '<value>']). Values are
 *     translated into starts-with constraints in the conditions field of the
 *     policy document (e.g. ['starts-with', '$<field>', '<value>']). If only
 *     one prefix condition is to be specified, options.startsWith can be a one-
 *     dimensional array (e.g. ['$<field>', '<value>']).
 * @param {string=} options.acl - ACL for the object from possibly predefined
 *     ACLs.
 * @param {string=} options.successRedirect - The URL to which the user client
 *     is redirected if the upload is successful.
 * @param {string=} options.successStatus - The status of the Google Storage
 *     response if the upload is successful (must be string).
 * @param {object=} options.contentLengthRange
 * @param {number} options.contentLengthRange.min - Minimum value for the
 *     request's content length.
 * @param {number} options.contentLengthRange.max - Maximum value for the
 *     request's content length.
 * @param {function} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 * @param {object} callback.policy - The document policy.
 *
 * @example
 * file.getSignedPolicy({
 *   equals: ['$Content-Type', 'image/jpeg'],
 *   contentLengthRange: { min: 0, max: 1024 },
 *   expiration: Math.round(Date.now() / 1000) + (60 * 60 * 24 * 14) // 2 weeks.
 * }, function(err, policy) {
 *   // policy.string: the policy document in plain text.
 *   // policy.base64: the policy document in base64.
 *   // policy.signature: the policy signature in base64.
 * });
 */
File.prototype.getSignedPolicy = function(options, callback) {
  if (options.expiration < Math.floor(Date.now() / 1000)) {
    throw new Error('An expiration date cannot be in the past.');
  }

  var expirationString = new Date(options.expiration).toISOString();
  var conditions = [
    ['eq', '$key', this.name],
    {
      bucket: this.bucket.name
    }
  ];

  if (is.array(options.equals)) {
    if (!is.array(options.equals[0])) {
      options.equals = [options.equals];
    }
    options.equals.forEach(function(condition) {
      if (!is.array(condition) || condition.length !== 2) {
        throw new Error('Equals condition must be an array of 2 elements.');
      }
      conditions.push(['eq', condition[0], condition[1]]);
    });
  }

  if (is.array(options.startsWith)) {
    if (!is.array(options.startsWith[0])) {
      options.startsWith = [options.startsWith];
    }
    options.startsWith.forEach(function(condition) {
      if (!is.array(condition) || condition.length !== 2) {
        throw new Error('StartsWith condition must be an array of 2 elements.');
      }
      conditions.push(['starts-with', condition[0], condition[1]]);
    });
  }

  if (options.acl) {
    conditions.push({
      acl: options.acl
    });
  }

  if (options.successRedirect) {
    conditions.push({
      success_action_redirect: options.successRedirect
    });
  }

  if (options.successStatus) {
    conditions.push({
      success_action_status: options.successStatus
    });
  }

  if (options.contentLengthRange) {
    var min = options.contentLengthRange.min;
    var max = options.contentLengthRange.max;
    if (!is.number(min) || !is.number(max)) {
      throw new Error('ContentLengthRange must have numeric min & max fields.');
    }
    conditions.push(['content-length-range', min, max]);
  }

  var policy = {
    expiration: expirationString,
    conditions: conditions
  };

  var makeAuthorizedRequest_ = this.bucket.storage.makeAuthorizedRequest_;

  makeAuthorizedRequest_.getCredentials(function(err, credentials) {
    if (err) {
      callback(err);
      return;
    }

    var sign = crypto.createSign('RSA-SHA256');
    var policyString = JSON.stringify(policy);
    var policyBase64 = new Buffer(policyString).toString('base64');

    sign.update(policyBase64);

    var signature = sign.sign(credentials.private_key, 'base64');

    callback(null, {
      string: policyString,
      base64: policyBase64,
      signature: signature
    });
  });
};

/**
 * Get a signed URL to allow limited time access to the file.
 *
 * @resource [Signed URLs Reference]{@link https://cloud.google.com/storage/docs/access-control#Signed-URLs}
 *
 * @throws {Error} if an expiration timestamp from the past is given.
 *
 * @param {object} options - Configuration object.
 * @param {string} options.action - "read", "write", or "delete"
 * @param {string=} options.contentMd5 - The MD5 digest value in base64. If you
 *     provide this, the client must provide this HTTP header with this same
 *     value in its request.
 * @param {string=} options.contentType - If you provide this value, the client
 *     must provide this HTTP header set to the same value.
 * @param {number} options.expires - Timestamp (seconds since epoch) when this
 *     link will expire.
 * @param {string=} options.extensionHeaders - If these headers are used, the
 *     server will check to make sure that the client provides matching values.
 * @param {string=} options.promptSaveAs - The filename to prompt the user to
 *     save the file as when the signed url is accessed. This is ignored if
 *     options.responseDisposition is set.
 * @param {string=} options.responseDisposition - The
 *     response-content-disposition parameter (http://goo.gl/yMWxQV) of the
 *     signed url.
 * @param {string=} options.responseType - The response-content-type parameter
 *     of the signed url.
 * @param {function=} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 * @param {string} callback.url - The signed URL.
 *
 * @example
 * var TWO_WEEKS_MS = Math.round(Date.now() / 1000) + (60 * 60 * 24 * 14);
 *
 * //-
 * // Generate a URL that allows temporary access to download your file.
 * //-
 * var request = require('request');
 *
 * file.getSignedUrl({
 *   action: 'read',
 *   expires: TWO_WEEKS_MS
 * }, function(err, url) {
 *   if (err) {
 *     console.error(err);
 *     return;
 *   }
 *
 *   // The file is now available to read from this URL.
 *   request(url, function(err, resp) {
 *     // resp.statusCode = 200
 *   });
 * });
 *
 * //-
 * // Generate a URL to allow write permissions. This means anyone with this URL
 * // can send a POST request with new data that will overwrite the file.
 * //-
 * file.getSignedUrl({
 *   action: 'write',
 *   expires: TWO_WEEKS_MS
 * }, function(err, url) {
 *   if (err) {
 *     console.error(err);
 *     return;
 *   }
 *
 *   // The file is now available to be written to.
 *   var writeStream = request.post(url);
 *   writeStream.end('New data');
 *
 *   writeStream.on('complete', function(resp) {
 *     // Confirm the new content was saved.
 *     file.download(function(err, fileContents) {
 *       console.log('Contents:', fileContents.toString());
 *       // Contents: New data
 *     });
 *   });
 * });
 */
File.prototype.getSignedUrl = function(options, callback) {
  if (options.expires < Math.floor(Date.now() / 1000)) {
    throw new Error('An expiration date cannot be in the past.');
  }

  options.action = {
    read: 'GET',
    write: 'PUT',
    delete: 'DELETE'
  }[options.action];

  var name = encodeURIComponent(this.name);

  options.resource = '/' + this.bucket.name + '/' + name;

  var makeAuthorizedRequest_ = this.bucket.storage.makeAuthorizedRequest_;

  makeAuthorizedRequest_.getCredentials(function(err, credentials) {
    if (err) {
      callback(err);
      return;
    }

    var sign = crypto.createSign('RSA-SHA256');
    sign.update([
      options.action,
      (options.contentMd5 || ''),
      (options.contentType || ''),
      options.expires,
      (options.extensionHeaders || '') + options.resource
    ].join('\n'));
    var signature = sign.sign(credentials.private_key, 'base64');

    var responseContentType = '';
    if (is.string(options.responseType)) {
      responseContentType =
        '&response-content-type=' +
        encodeURIComponent(options.responseType);
    }

    var responseContentDisposition = '';
    if (is.string(options.promptSaveAs)) {
      responseContentDisposition =
        '&response-content-disposition=attachment; filename="' +
        encodeURIComponent(options.promptSaveAs) + '"';
    }
    if (is.string(options.responseDisposition)) {
      responseContentDisposition =
        '&response-content-disposition=' +
        encodeURIComponent(options.responseDisposition);
    }

    callback(null, [
      'https://storage.googleapis.com' + options.resource,
      '?GoogleAccessId=' + credentials.client_email,
      '&Expires=' + options.expires,
      '&Signature=' + encodeURIComponent(signature),
      responseContentType,
      responseContentDisposition
    ].join(''));
  });
};

/**
 * Merge the given metadata with the current remote file's metadata. This will
 * set metadata if it was previously unset or update previously set metadata. To
 * unset previously set metadata, set its value to null.
 *
 * You can set custom key/value pairs in the metadata key of the given object,
 * however the other properties outside of this object must adhere to the
 * [official API documentation](https://goo.gl/BOnnCK).
 *
 * See the examples below for more information.
 *
 * @resource [Objects: patch API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objects/patch}
 *
 * @param {object} metadata - The metadata you wish to update.
 * @param {function=} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 * @param {object} callback.metadata - The File's metadata.
 * @param {object} callback.apiResponse - The full API response.
 *
 * @example
 * file.setMetadata({
 *   contentType: 'application/x-font-ttf',
 *   metadata: {
 *     my: 'custom',
 *     properties: 'go here'
 *   }
 * }, function(err, metadata, apiResponse) {});
 *
 * // Assuming current metadata = { hello: 'world', unsetMe: 'will do' }
 * file.setMetadata({
 *   metadata: {
 *     abc: '123', // will be set.
 *     unsetMe: null, // will be unset (deleted).
 *     hello: 'goodbye' // will be updated from 'hello' to 'goodbye'.
 *   }
 * }, function(err, metadata, apiResponse) {
 *   // metadata should now be { abc: '123', hello: 'goodbye' }
 * });
 */
File.prototype.setMetadata = function(metadata, callback) {
  callback = callback || util.noop;

  var that = this;
  var path = '/o/' + encodeURIComponent(this.name);
  var query = {};

  if (this.generation) {
    query.generation = this.generation;
  }

  this.makeReq_('PATCH', path, query, metadata, function(err, resp) {
    if (err) {
      callback(err, null, resp);
      return;
    }

    that.metadata = resp;

    callback(null, that.metadata, resp);
  });
};

/**
 * Make a file private to the project and remove all other permissions.
 * Set `options.strict` to true to make the file private to only the owner.
 *
 * @resource [Objects: patch API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objects/patch}
 *
 * @param {object=} options - The configuration object.
 * @param {boolean=} options.strict - If true, set the file to be private to
 *     only the owner user. Otherwise, it will be private to the project.
 * @param {function=} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 *
 * @example
 *
 * //-
 * // Set the file private so only project maintainers can see and modify it.
 * //-
 * file.makePrivate(function(err) {});
 *
 * //-
 * // Set the file private so only the owner can see and modify it.
 * //-
 * file.makePrivate({ strict: true }, function(err) {});
 */
File.prototype.makePrivate = function(options, callback) {
  var that = this;
  if (is.fn(options)) {
    callback = options;
    options = {};
  }
  var path = '/o/' + encodeURIComponent(this.name);
  var query = { predefinedAcl: options.strict ? 'private' : 'projectPrivate' };

  // You aren't allowed to set both predefinedAcl & acl properties on a file, so
  // acl must explicitly be nullified, destroying all previous acls on the file.
  var metadata = { acl: null };

  callback = callback || util.noop;

  this.makeReq_('PATCH', path, query, metadata, function(err, resp) {
    if (err) {
      callback(err);
      return;
    }

    that.metadata = resp;

    callback(null);
  });
};

/**
 * Set a file to be publicly readable and maintain all previous permissions.
 *
 * @resource [ObjectAccessControls: insert API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objectAccessControls/insert}
 *
 * @param {function=} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request.
 * @param {object} callback.apiResponse - The full API response.
 *
 * @example
 * file.makePublic(function(err, apiResponse) {});
 */
File.prototype.makePublic = function(callback) {
  callback = callback || util.noop;

  this.acl.add({
    entity: 'allUsers',
    role: 'READER'
  }, function(err, resp) {
    callback(err, resp);
  });
};

/**
 * `startResumableUpload_` uses the Resumable Upload API: http://goo.gl/jb0e9D.
 *
 * The process involves these steps:
 *
 *   1. POST the file's metadata. We get a resumable upload URI back, then cache
 *      it with ConfigStore.
 *   2. PUT data to that URI with a Content-Range header noting what position
 *      the data is beginning from. We also cache, at most, the first 16 bytes
 *      of the data being uploaded.
 *   3. Delete the ConfigStore cache after the upload completes.
 *
 * If the initial upload operation is interrupted, the next time the user
 * uploads the file, these steps occur:
 *
 *   1. Detect the presence of a cached URI in ConfigStore.
 *   2. Make an empty PUT request to that URI to get the last byte written to
 *      the remote file.
 *   3. PUT data to the URI starting from the first byte after the last byte
 *      returned from the call above.
 *
 * If the user tries to upload entirely different data to the remote file:
 *
 *   1. -- same as above --
 *   2. -- same as above --
 *   3. -- same as above --
 *   4. Compare the first chunk of the new data with the chunk in cache. If it's
 *      different, start a new resumable upload (Step 1 of the first example).
 *
 * @param {Duplexify} stream - Duplexify stream of data to pipe to the file.
 * @param {object=} metadata - Optional metadata to set on the file.
 *
 * @private
 */
File.prototype.startResumableUpload_ = function(stream, metadata) {
  metadata = metadata || {};

  var that = this;
  var configStore = new ConfigStore('gcloud-node');
  var config = configStore.get(that.name);
  var makeAuthorizedRequest = that.bucket.storage.makeAuthorizedRequest_;

  var numBytesWritten;
  var resumableUri;
  var RETRY_LIMIT = 5;
  var retries = 0;

  // This is used to hold all data coming in from the user's readable stream. If
  // we need to abort a resumable upload to start a new one, this will hold the
  // data until we're ready again.
  var bufferStream = through();

  if (config && config.uri) {
    resumableUri = config.uri;
    resumeUpload();
  } else {
    startUpload();
  }

  // Begin a new resumable upload. Send the metadata and cache the URI returned.
  function startUpload() {
    var headers = {};

    if (metadata.contentType) {
      headers['X-Upload-Content-Type'] = metadata.contentType;
    }

    var reqOpts = {
      method: 'POST',
      uri: format('{base}/{bucket}/o', {
        base: STORAGE_UPLOAD_BASE_URL,
        bucket: that.bucket.name
      }),
      qs: {
        name: that.name,
        uploadType: 'resumable'
      },
      headers: headers,
      json: metadata
    };

    if (that.generation) {
      reqOpts.qs.ifGenerationMatch = that.generation;
    }

    makeAuthorizedRequest(reqOpts, function(err, res, body) {
      if (err) {
        handleError(err);
        return;
      }

      numBytesWritten = -1;
      resumableUri = body.headers.location;

      configStore.set(that.name, {
        uri: resumableUri
      });

      resumeUpload();
    });
  }

  // Given a byte offset, create an authorized request to the resumable URI. If
  // resuming an upload, we first determine the last byte written, then create
  // the authorized request.
  function resumeUpload() {
    if (is.number(numBytesWritten)) {
      createUploadRequest(numBytesWritten);
    } else {
      getNumBytesWritten(createUploadRequest);
    }

    function createUploadRequest(offset) {
      makeAuthorizedRequest({
        method: 'PUT',
        uri: resumableUri
      }, {
        onAuthorized: function(err, reqOpts) {
          if (err) {
            handleError(err);
            return;
          }

          sendFile(reqOpts, offset + 1);
        }
      });
    }
  }

  // Given an authorized request and a byte offset, begin sending data to the
  // resumable URI from where the upload last left off.
  function sendFile(reqOpts, offset) {
    reqOpts.headers['Content-Range'] = 'bytes ' + offset + '-*/*';

    var bytesWritten = 0;

    var offsetStream = through(function(chunk, enc, next) {
      // Determine if this is the same content uploaded previously. We do this
      // by caching a slice of the first chunk, then comparing it with the first
      // byte of incoming data.
      if (bytesWritten === 0) {
        var cachedFirstChunk = config && config.firstChunk;
        var firstChunk = chunk.slice(0, 16).valueOf();

        if (!cachedFirstChunk) {
          // This is a new upload. Cache the first chunk.
          configStore.set(that.name, {
            uri: reqOpts.uri,
            firstChunk: firstChunk
          });
        } else {
          // This is a continuation of an upload. Make sure the first bytes are
          // the same.
          cachedFirstChunk = new Buffer(cachedFirstChunk);
          firstChunk = new Buffer(firstChunk);

          if (!bufferEqual(cachedFirstChunk, firstChunk)) {
            // The data being uploaded now is different than the original data.
            // Give the chunk back to the stream and create a new upload stream.
            bufferStream.unshift(chunk);
            bufferStream.unpipe(this);

            configStore.del(that.name);

            startUpload();
            return;
          }
        }
      }

      var length = chunk.length;

      if (is.string(chunk)) {
        length = Buffer.byteLength(chunk, enc);
      }

      if (bytesWritten < offset) {
        chunk = chunk.slice(offset - bytesWritten);
      }

      bytesWritten += length;

      // Only push data to the request stream from the byte after the one we
      // left off on.
      if (bytesWritten > offset) {
        this.push(chunk);
      }

      next();
    });

    var writeStream = request(reqOpts);
    writeStream.callback = util.noop;

    writeStream.on('error', function(err) {
      handleError(err);
    });

    writeStream.on('complete', function(res) {
      util.handleResp(null, res, res.body, function(err, data) {
        if (err) {
          handleError(err);
          return;
        }

        that.metadata = data;

        stream.emit('complete', that.metadata);

        configStore.del(that.name);
      });
    });

    bufferStream.pipe(offsetStream).pipe(writeStream);
    stream.setWritable(bufferStream);
  }

  // If an upload to this file has previously started, this will return the last
  // byte written to it.
  function getNumBytesWritten(callback) {
    makeAuthorizedRequest({
      method: 'PUT',
      uri: resumableUri,
      headers: {
        'Content-Length': 0,
        'Content-Range': 'bytes */*'
      }
    }, function(err) {
      var RESUME_INCOMPLETE_STATUS = 308;

      if (err && err.code === RESUME_INCOMPLETE_STATUS) {
        // headers.range format: ##-## (e.g. 0-4915200)
        if (err.response.headers.range) {
          callback(parseInt(err.response.headers.range.split('-')[1]));
          return;
        }
      }

      // Start from the first byte.
      callback(-1);
    });
  }

  // Handle an error from API calls following the recommended best practices:
  // http://goo.gl/AajKku
  function handleError(err) {
    if (err.code === 404 && retries < RETRY_LIMIT) {
      retries++;
      startUpload();
      return;
    }

    if (err.code > 499 && err.code < 600 && retries < RETRY_LIMIT) {
      // Exponential backoff: http://goo.gl/CifIFy
      var randomMs = Math.round(Math.random() * 1000);
      var waitTime = Math.pow(2, retries) * 1000 + randomMs;

      retries++;

      // Reset `numBytesWritten` so we update this value by pinging the API.
      numBytesWritten = null;

      setTimeout(resumeUpload, waitTime);
      return;
    }

    stream.destroy(err);
  }
};

/**
 * Takes a readable stream and pipes it to a remote file. Unlike
 * `startResumableUpload_`, which uses the resumable upload technique, this
 * method uses a simple upload (all or nothing).
 *
 * @param {Duplexify} stream - Duplexify stream of data to pipe to the file.
 * @param {object=} metadata - Optional metadata to set on the file.
 *
 * @private
 */
File.prototype.startSimpleUpload_ = function(stream, metadata) {
  var that = this;

  var reqOpts = {
    qs: {
      name: that.name
    },
    uri: format('{base}/{bucket}/o', {
      base: STORAGE_UPLOAD_BASE_URL,
      bucket: that.bucket.name
    })
  };

  if (this.generation) {
    reqOpts.qs.ifGenerationMatch = this.generation;
  }

  util.makeWritableStream(stream, {
    makeAuthorizedRequest: that.bucket.storage.makeAuthorizedRequest_,
    metadata: metadata,
    request: reqOpts
  }, function(data) {
    that.metadata = data;

    stream.emit('complete', data);
  });
};

module.exports = File;