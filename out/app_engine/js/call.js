/*
 *  Copyright (c) 2014 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */

/* More information about these options at jshint.com/docs/options */

/* globals trace, requestIceServers, sendUrlRequest, sendAsyncUrlRequest,
   SignalingChannel, PeerConnectionClient, setupLoopback,
   parseJSON, apprtc, Constants */

/* exported Call */

'use strict';

var Call = function(params) {
  this.params_ = params;
  this.roomServer_ = params.roomServer || '';

  this.channel_ = new SignalingChannel(params.wssUrl, params.wssPostUrl);
  this.channel_.onmessage = this.onRecvSignalingChannelMessage_.bind(this);

  this.pcClient_ = null;
  this.localStream_ = null;
  this.errorMessageQueue_ = [];
  this.startTime = null;

  // Public callbacks. Keep it sorted.
  this.oncallerstarted = null;
  this.onerror = null;
  this.oniceconnectionstatechange = null;
  this.onlocalstreamadded = null;
  this.onnewicecandidate = null;
  this.onremotehangup = null;
  this.onremotesdpset = null;
  this.onremotestreamadded = null;
  this.onsignalingstatechange = null;
  this.onturnstatusmessage = null;

  this.getMediaPromise_ = null;
  this.getIceServersPromise_ = null;
  this.requestMediaAndIceServers_();
};

Call.prototype.requestMediaAndIceServers_ = function() {
  this.getMediaPromise_ = this.maybeGetMedia_();
  this.getIceServersPromise_ = this.maybeGetIceServers_();
};

Call.prototype.isInitiator = function() {
  return this.params_.isInitiator;
};

Call.prototype.start = function(roomId) {
  this.connectToRoom_(roomId);
  if (this.params_.isLoopback) {
    setupLoopback(this.params_.wssUrl, roomId);
  }
};

Call.prototype.restart = function() {
  // Reinitialize the promises so the media gets hooked up as a result
  // of calling maybeGetMedia_.
  this.requestMediaAndIceServers_();
  this.start(this.params_.previousRoomId);
};

Call.prototype.hangup = function(async) {
  this.startTime = null;

  if (this.localStream_) {
    if (typeof this.localStream_.getTracks === 'undefined') {
      // Support legacy browsers, like phantomJs we use to run tests.
      this.localStream_.stop();
    } else {
      this.localStream_.getTracks().forEach(function(track) {
        track.stop();
      });
    }
    this.localStream_ = null;
  }

  if (!this.params_.roomId) {
    return;
  }

  if (this.pcClient_) {
    this.pcClient_.close();
    this.pcClient_ = null;
  }

  // Send 'leave' to GAE. This must complete before saying BYE to other client.
  // When the other client sees BYE it attempts to post offer and candidates to
  // GAE. GAE needs to know that we're disconnected at that point otherwise
  // it will forward messages to this client instead of storing them.

  // This section of code is executed in both sync and async depending on
  // where it is called from. When the browser is closed, the requests must
  // be executed as sync to finish before the browser closes. When called
  // from pressing the hang up button, the requests are executed async.

  var steps = [];
  steps.push({
    step: function() {
      // Send POST request to /leave.
      var path = this.getLeaveUrl_();
      return sendUrlRequest('POST', path, async);
    }.bind(this),
    errorString: 'Error sending /leave:'
  });
  steps.push({
    step: function() {
      // Send bye to the other client.
      this.channel_.send(JSON.stringify({type: 'bye'}));
    }.bind(this),
    errorString: 'Error sending bye:'
  });
  steps.push({
    step: function() {
      // Close signaling channel.
      return this.channel_.close(async);
    }.bind(this),
    errorString: 'Error closing signaling channel:'
  });
  steps.push({
    step: function() {
      this.params_.previousRoomId = this.params_.roomId;
      this.params_.roomId = null;
      this.params_.clientId = null;
    }.bind(this),
    errorString: 'Error setting params:'
  });

  if (async) {
    var errorHandler = function(errorString, error) {
      trace(errorString + ' ' + error.message);
    };
    var promise = Promise.resolve();
    for (var i = 0; i < steps.length; ++i) {
      promise = promise.then(steps[i].step).catch(
          errorHandler.bind(this, steps[i].errorString));
    }

    return promise;
  }
  // Execute the cleanup steps.
  var executeStep = function(executor, errorString) {
    try {
      executor();
    } catch (ex) {
      trace(errorString + ' ' + ex);
    }
  };

  for (var j = 0; j < steps.length; ++j) {
    executeStep(steps[j].step, steps[j].errorString);
  }

  if (this.params_.roomId !== null || this.params_.clientId !== null) {
    trace('ERROR: sync cleanup tasks did not complete successfully.');
  } else {
    trace('Cleanup completed.');
  }
  return Promise.resolve();
};

Call.prototype.getLeaveUrl_ = function() {
  return this.roomServer_ + '/leave/' + this.params_.roomId +
      '/' + this.params_.clientId;
};

Call.prototype.onRemoteHangup = function() {
  this.startTime = null;

  // On remote hangup this client becomes the new initiator.
  this.params_.isInitiator = true;

  if (this.pcClient_) {
    this.pcClient_.close();
    this.pcClient_ = null;
  }

  this.startSignaling_();
};

Call.prototype.getPeerConnectionStates = function() {
  if (!this.pcClient_) {
    return null;
  }
  return this.pcClient_.getPeerConnectionStates();
};

Call.prototype.getPeerConnectionStats = function(callback) {
  if (!this.pcClient_) {
    return;
  }
  this.pcClient_.getPeerConnectionStats(callback);
};

Call.prototype.toggleVideoMute = function() {
  var videoTracks = this.localStream_.getVideoTracks();
  if (videoTracks.length === 0) {
    trace('No local video available.');
    return;
  }

  trace('Toggling video mute state.');
  for (var i = 0; i < videoTracks.length; ++i) {
    videoTracks[i].enabled = !videoTracks[i].enabled;
  }
  trace('Video ' + (videoTracks[0].enabled ? 'unmuted.' : 'muted.'));
};

Call.prototype.toggleAudioMute = function() {
  var audioTracks = this.localStream_.getAudioTracks();
  if (audioTracks.length === 0) {
    trace('No local audio available.');
    return;
  }

  trace('Toggling audio mute state.');
  for (var i = 0; i < audioTracks.length; ++i) {
    audioTracks[i].enabled = !audioTracks[i].enabled;
  }
  trace('Audio ' + (audioTracks[0].enabled ? 'unmuted.' : 'muted.'));
};

// Connects client to the room. This happens by simultaneously requesting
// media, requesting turn, and join the room. Once all three of those
// tasks is complete, the signaling process begins. At the same time, a
// WebSocket connection is opened using |wss_url| followed by a subsequent
// registration once GAE registration completes.
Call.prototype.connectToRoom_ = function(roomId) {
  this.params_.roomId = roomId;
  // Asynchronously open a WebSocket connection to WSS.
  // TODO(jiayl): We don't need to wait for the signaling channel to open before
  // start signaling.
  var channelPromise = this.channel_.open().catch(function(error) {
    this.onError_('WebSocket open error: ' + error.message);
    return Promise.reject(error);
  }.bind(this));

  // Asynchronously join the room.
  var joinPromise =
      this.joinRoom_().then(function(roomParams) {
        // The only difference in parameters should be clientId and isInitiator,
        // and the turn servers that we requested.
        // TODO(tkchin): clean up response format. JSHint doesn't like it.

        this.params_.clientId = roomParams.client_id;
        this.params_.roomId = roomParams.room_id;
        this.params_.roomLink = roomParams.room_link;
        this.params_.isInitiator = roomParams.is_initiator === 'true';

        this.params_.messages = roomParams.messages;
      }.bind(this)).catch(function(error) {
        this.onError_('Room server join error: ' + error.message);
        return Promise.reject(error);
      }.bind(this));

  // We only register with WSS if the web socket connection is open and if we're
  // already registered with GAE.
  Promise.all([channelPromise, joinPromise]).then(function() {
    this.channel_.register(this.params_.roomId, this.params_.clientId);

    // We only start signaling after we have registered the signaling channel
    // and have media and TURN. Since we send candidates as soon as the peer
    // connection generates them we need to wait for the signaling channel to be
    // ready.
    Promise.all([this.getIceServersPromise_, this.getMediaPromise_])
        .then(function() {
          this.startSignaling_();
        }.bind(this)).catch(function(error) {
          this.onError_('Failed to start signaling: ' + error.message);
        }.bind(this));
  }.bind(this)).catch(function(error) {
    this.onError_('WebSocket register error: ' + error.message);
  }.bind(this));
};

function clone(obj)
{
  var output = {};
  for(var i in obj)
  {
    output[i] = obj[i];
  }
  return output;
}

function fullCanvasRenderHandler(stream, textToDisplay) {
  // on-video-render:
  // called as soon as this video stream is drawn (painted or recorded) on canvas2d surface
  stream.onRender = function(context, x, y, width, height, idx) {
      context.font = '50px Georgia';
      var measuredTextWidth = parseInt(context.measureText(textToDisplay).width);
      x = x + (parseInt((width - measuredTextWidth)) - 40);
      y = y + 80;
      context.strokeStyle = 'rgb(255, 0, 0)';
      context.fillStyle = 'rgba(255, 255, 0, .5)';
      roundRect(context, x - 20, y - 55, measuredTextWidth + 40, 75, 20, true);
      var gradient = context.createLinearGradient(0, 0, width * 2, 0);
      gradient.addColorStop('0', 'magenta');
      gradient.addColorStop('0.5', 'blue');
      gradient.addColorStop('1.0', 'red');
      context.fillStyle = gradient;
      context.fillText(textToDisplay, x, y);
  };
}

function normalVideoRenderHandler(stream, textToDisplay, callback) {
  // on-video-render:
  // called as soon as this video stream is drawn (painted or recorded) on canvas2d surface
  stream.onRender = function(context, x, y, width, height, idx, ignoreCB) {
      if(!ignoreCB && callback) {
          callback(context, x, y, width, height, idx, textToDisplay);
          return;
      }

      context.font = '40px Georgia';
      var measuredTextWidth = parseInt(context.measureText(textToDisplay).width);
      x = x + (parseInt((width - measuredTextWidth)) / 2);
      y = (context.canvas.height - height) + 50;
      context.strokeStyle = 'rgb(255, 0, 0)';
      context.fillStyle = 'rgba(255, 255, 0, .5)';
      roundRect(context, x - 20, y - 35, measuredTextWidth + 40, 45, 20, true);
      var gradient = context.createLinearGradient(0, 0, width * 2, 0);
      gradient.addColorStop('0', 'magenta');
      gradient.addColorStop('0.5', 'blue');
      gradient.addColorStop('1.0', 'red');
      context.fillStyle = gradient;
      context.fillText(textToDisplay, x, y);
  };
}

/**
* Draws a rounded rectangle using the current state of the canvas.
* If you omit the last three params, it will draw a rectangle
* outline with a 5 pixel border radius
* @param {CanvasRenderingContext2D} ctx
* @param {Number} x The top left x coordinate
* @param {Number} y The top left y coordinate
* @param {Number} width The width of the rectangle
* @param {Number} height The height of the rectangle
* @param {Number} [radius = 5] The corner radius; It can also be an object 
*                 to specify different radii for corners
* @param {Number} [radius.tl = 0] Top left
* @param {Number} [radius.tr = 0] Top right
* @param {Number} [radius.br = 0] Bottom right
* @param {Number} [radius.bl = 0] Bottom left
* @param {Boolean} [fill = false] Whether to fill the rectangle.
* @param {Boolean} [stroke = true] Whether to stroke the rectangle.
*/
// via: http://stackoverflow.com/a/3368118/552182
function roundRect(ctx, x, y, width, height, radius, fill, stroke) {
  if (typeof stroke == 'undefined') {
      stroke = true;
  }
  if (typeof radius === 'undefined') {
      radius = 5;
  }
  if (typeof radius === 'number') {
      radius = {
          tl: radius,
          tr: radius,
          br: radius,
          bl: radius
      };
  } else {
      var defaultRadius = {
          tl: 0,
          tr: 0,
          br: 0,
          bl: 0
      };
      for (var side in defaultRadius) {
          radius[side] = radius[side] || defaultRadius[side];
      }
  }
  ctx.beginPath();
  ctx.moveTo(x + radius.tl, y);
  ctx.lineTo(x + width - radius.tr, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius.tr);
  ctx.lineTo(x + width, y + height - radius.br);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius.br, y + height);
  ctx.lineTo(x + radius.bl, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius.bl);
  ctx.lineTo(x, y + radius.tl);
  ctx.quadraticCurveTo(x, y, x + radius.tl, y);
  ctx.closePath();
  if (fill) {
      ctx.fill();
  }
  if (stroke) {
      ctx.stroke();
  }
}

var get_stream = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
// console.log("navigator : ", navigator.mediaDevices.getUserMedia);
// console.log("get_stream : ", get_stream);
navigator.mediaDevices.getUserMedia = function(constraints) 
{
  var fullCanvasStream = new MediaStream();
  var clonedCamera2 = new MediaStream();
  var mixer;

  get_stream(constraints).
  catch(function(error) {
    console.log("!!smh failure");
  }).
  then(function(stream1){
    stream1.getTracks().forEach(function(track) {
      fullCanvasStream.addTrack(track);
    });

    fullCanvasStream.fullcanvas = true;
    fullCanvasStream.width = screen.width; // or 3840
    fullCanvasStream.height = screen.height; // or 2160 

    fullCanvasRenderHandler(fullCanvasStream, 'stream1');
    console.log("!!!first stream finish");
    console.log("!!smh success");

    get_stream(constraints).
    catch(function(error) {
      console.log("!!smh failure");
    }).
    then(function(stream2)
    {
      // phone
      stream2.getTracks().forEach(function(track) {
        clonedCamera2.addTrack(track);
      });
  
      clonedCamera2.width = parseInt((30 / 100) * fullCanvasStream.width);
      clonedCamera2.height = parseInt((30 / 100) * fullCanvasStream.height);
      clonedCamera2.top = fullCanvasStream.height - clonedCamera2.height;
      clonedCamera2.left = fullCanvasStream.width - (clonedCamera2.width * 2);

      normalVideoRenderHandler(clonedCamera2, 'Someone');
      
      console.log("!!!second stream finish");
      mixer = new MultiStreamsMixer([fullCanvasStream, clonedCamera2]);
      mixer.frameInterval = 1;
      mixer.startDrawingFrames();

      let thisPromise = new Promise((resolve, reject) => {
        //globalResolveForGetUserMedia = resolve;
        mixer = new MultiStreamsMixer([stream1, stream2]);
        mixer.frameInterval = 1;
        mixer.startDrawingFrames();
        mixer.getMixedStream() = resolve;
      });
      return thisPromise;
    });
  });
  return null;
}
/*
navigator.mediaDevices.getUserMedia = function(constraints) 
{
  console.log("!!!constraints ", constraints);
  var mixer;
  var first_mediaPromise, second_mediaPromise;

  var fullCanvasStream = new MediaStream();
  var clonedCamera2 = new MediaStream();

  first_mediaPromise = get_stream(constraints)
  .catch(function(error){
    print("error2");
  })
  .then(stream1 =>
    {
      print("!!!first stream finish");
      stream1.getTracks().forEach(function(track) {
          fullCanvasStream.addTrack(track);
      });

      fullCanvasStream.fullcanvas = true;
      fullCanvasStream.width = screen.width; // or 3840
      fullCanvasStream.height = screen.height; // or 2160 

      fullCanvasRenderHandler(fullCanvasStream, 'stream1');
      print("!!!first stream finish");

      second_mediaPromise = get_stream(constraints)
      .catch(function(error){
        print("error2");
      })
      .then(stream2 =>{
        stream2.width = parseInt((30 / 100) * fullCanvasStream.width);
        stream2.height = parseInt((30 / 100) * fullCanvasStream.height);
        stream2.top = fullCanvasStream.height - stream2.height;
        stream2.left = stream2.width - stream2.width;

        clonedCamera2 = new MediaStream();
        stream2.getTracks().forEach(function(track) {
            clonedCamera2.addTrack(track);
        });

        clonedCamera2.width = parseInt((30 / 100) * fullCanvasStream.width);
        clonedCamera2.height = parseInt((30 / 100) * fullCanvasStream.height);
        clonedCamera2.top = fullCanvasStream.height - clonedCamera2.height;
        clonedCamera2.left = fullCanvasStream.width - (clonedCamera2.width * 2);

        normalVideoRenderHandler(clonedCamera2, 'Someone');
        normalVideoRenderHandler(stream2, 'You!');
        
        print("!!!second stream finish");
        mixer = new MultiStreamsMixer([fullCanvasStream, clonedCamera2, stream2]);
        mixer.frameInterval = 1;
        mixer.startDrawingFrames();

        //this.onUserMediaSuccess_(mixer.getMixedStream());
        print("!!!no error!!");
      })
  });

  let thisPromise = new Promise((resolve, reject) => {
      //globalResolveForGetUserMedia = resolve;
      mixer = new MultiStreamsMixer([stream1, stream2]);
      mixer.frameInterval = 1;
      mixer.startDrawingFrames();
      mixer.getMixedStream() = resolve;

  });

  return thisPromise;
};
*/

// Asynchronously request user media if needed.
Call.prototype.maybeGetMedia_ = function() {
  // mediaConstraints.audio and mediaConstraints.video could be objects, so
  // check '!=== false' instead of '=== true'.
  var needStream = (this.params_.mediaConstraints.audio !== false || this.params_.mediaConstraints.video !== false);
  var mediaPromise = null;
  if (needStream) {
    var mediaConstraints = this.params_.mediaConstraints;

    mediaPromise = navigator.mediaDevices.getUserMedia(mediaConstraints)
        .catch(function(error) {
          if (error.name !== 'NotFoundError') {
            throw error;
          }
          return navigator.mediaDevices.enumerateDevices()
              .then(function(devices) {
                var cam = devices.find(function(device) {
                  return device.kind === 'videoinput';
                });
                var mic = devices.find(function(device) {
                  return device.kind === 'audioinput';
                });
                var constraints = {
                  video: cam && mediaConstraints.video,
                  audio: mic && mediaConstraints.audio
                };
                return navigator.mediaDevices.getUserMedia(constraints);
              });
        })
        .then(function(stream) {
          trace('Got access to local media with mediaConstraints:\n' +
          '  \'' + JSON.stringify(mediaConstraints) + '\'');         
          this.onUserMediaSuccess_(stream);
        }.bind(this)).catch(function(error) {
          this.onError_('Error getting user media: ' + error.message);
          this.onUserMediaError_(error);
        }.bind(this));
  } else {
    mediaPromise = Promise.resolve();
  }
  return mediaPromise;

};

// Asynchronously request an ICE server if needed.
Call.prototype.maybeGetIceServers_ = function() {
  var shouldRequestIceServers =
      (this.params_.iceServerRequestUrl &&
      this.params_.iceServerRequestUrl.length > 0 &&
      this.params_.peerConnectionConfig.iceServers &&
      this.params_.peerConnectionConfig.iceServers.length === 0);

  var iceServerPromise = null;
  if (shouldRequestIceServers) {
    var requestUrl = this.params_.iceServerRequestUrl;
    iceServerPromise =
        requestIceServers(requestUrl, this.params_.iceServerTransports).then(
            function(iceServers) {
              var servers = this.params_.peerConnectionConfig.iceServers;
              this.params_.peerConnectionConfig.iceServers =
              servers.concat(iceServers);
            }.bind(this)).catch(function(error) {
          if (this.onturnstatusmessage) {
            // Error retrieving ICE servers.
            var subject =
                encodeURIComponent('AppRTC demo ICE servers not working');
            this.onturnstatusmessage(
                'No TURN server; unlikely that media will traverse networks. ' +
                'If this persists please ' +
                '<a href="mailto:discuss-webrtc@googlegroups.com?' +
                'subject=' + subject + '">' +
                'report it to discuss-webrtc@googlegroups.com</a>.');
          }
          trace(error.message);
        }.bind(this));
  } else {
    iceServerPromise = Promise.resolve();
  }
  return iceServerPromise;
};

Call.prototype.onUserMediaSuccess_ = function(stream) {
  this.localStream_ = stream;
  if (this.onlocalstreamadded) {
    this.onlocalstreamadded(stream);
  }
};

Call.prototype.onUserMediaError_ = function(error) {
  var errorMessage = 'Failed to get access to local media. Error name was ' +
      error.name + '. Continuing without sending a stream.';
  this.onError_('getUserMedia error: ' + errorMessage);
  this.errorMessageQueue_.push(error);
  alert(errorMessage);
};

Call.prototype.maybeCreatePcClientAsync_ = function() {
  return new Promise(function(resolve, reject) {
    if (this.pcClient_) {
      resolve();
      return;
    }

    if (typeof RTCPeerConnection.generateCertificate === 'function') {
      var certParams = {name: 'ECDSA', namedCurve: 'P-256'};
      RTCPeerConnection.generateCertificate(certParams)
          .then(function(cert) {
            trace('ECDSA certificate generated successfully.');
            this.params_.peerConnectionConfig.certificates = [cert];
            this.createPcClient_();
            resolve();
          }.bind(this))
          .catch(function(error) {
            trace('ECDSA certificate generation failed.');
            reject(error);
          });
    } else {
      this.createPcClient_();
      resolve();
    }
  }.bind(this));
};

Call.prototype.createPcClient_ = function() {
  this.pcClient_ = new PeerConnectionClient(this.params_, this.startTime);
  this.pcClient_.onsignalingmessage = this.sendSignalingMessage_.bind(this);
  this.pcClient_.onremotehangup = this.onremotehangup;
  this.pcClient_.onremotesdpset = this.onremotesdpset;
  this.pcClient_.onremotestreamadded = this.onremotestreamadded;
  this.pcClient_.onsignalingstatechange = this.onsignalingstatechange;
  this.pcClient_.oniceconnectionstatechange = this.oniceconnectionstatechange;
  this.pcClient_.onnewicecandidate = this.onnewicecandidate;
  this.pcClient_.onerror = this.onerror;
  trace('Created PeerConnectionClient');
};

Call.prototype.startSignaling_ = function() {
  trace('Starting signaling.');
  if (this.isInitiator() && this.oncallerstarted) {
    this.oncallerstarted(this.params_.roomId, this.params_.roomLink);
  }

  this.startTime = window.performance.now();

  this.maybeCreatePcClientAsync_()
      .then(function() {
        if (this.localStream_) {
          trace('Adding local stream.');
          this.pcClient_.addStream(this.localStream_);
        }
        if (this.params_.isInitiator) {
          this.pcClient_.startAsCaller(this.params_.offerOptions);
        } else {
          this.pcClient_.startAsCallee(this.params_.messages);
        }
      }.bind(this))
      .catch(function(e) {
        this.onError_('Create PeerConnection exception: ' + e);
        alert('Cannot create RTCPeerConnection: ' + e.message);
      }.bind(this));
};

// Join the room and returns room parameters.
Call.prototype.joinRoom_ = function() {
  return new Promise(function(resolve, reject) {
    if (!this.params_.roomId) {
      reject(Error('Missing room id.'));
    }
    var path = this.roomServer_ + '/join/' +
        this.params_.roomId + window.location.search;

    sendAsyncUrlRequest('POST', path).then(function(response) {
      var responseObj = parseJSON(response);
      if (!responseObj) {
        reject(Error('Error parsing response JSON.'));
        return;
      }
      if (responseObj.result !== 'SUCCESS') {
        // TODO (chuckhays) : handle room full state by returning to room
        // selection state.
        // When room is full, responseObj.result === 'FULL'
        reject(Error('Registration error: ' + responseObj.result));
        if (responseObj.result === 'FULL') {
          var getPath = this.roomServer_ + '/r/' +
              this.params_.roomId + window.location.search;
          window.location.assign(getPath);
        }
        return;
      }
      trace('Joined the room.');
      resolve(responseObj.params);
    }.bind(this)).catch(function(error) {
      reject(Error('Failed to join the room: ' + error.message));
      return;
    }.bind(this));
  }.bind(this));
};

Call.prototype.onRecvSignalingChannelMessage_ = function(msg) {
  this.maybeCreatePcClientAsync_()
      .then(this.pcClient_.receiveSignalingMessage(msg));
};

Call.prototype.sendSignalingMessage_ = function(message) {
  var msgString = JSON.stringify(message);
  if (this.params_.isInitiator) {
    // Initiator posts all messages to GAE. GAE will either store the messages
    // until the other client connects, or forward the message to Collider if
    // the other client is already connected.
    // Must append query parameters in case we've specified alternate WSS url.
    var path = this.roomServer_ + '/message/' + this.params_.roomId +
        '/' + this.params_.clientId + window.location.search;
    var xhr = new XMLHttpRequest();
    xhr.open('POST', path, true);
    xhr.send(msgString);
    trace('C->GAE: ' + msgString);
  } else {
    this.channel_.send(msgString);
  }
};

Call.prototype.onError_ = function(message) {
  if (this.onerror) {
    this.onerror(message);
  }
};
