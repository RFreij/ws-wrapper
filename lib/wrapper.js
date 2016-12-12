const WebSocketChannel = require("./channel"),
	debug = require("./debug");

class WebSocketWrapper extends WebSocketChannel {
	constructor(socket) {
		// Make `this` a WebSocketChannel
		super();
		this._wrapper = this;

		// Flag set once the socket is opened
		this._opened = false;
		// Array of data to be sent once the connection is opened
		this._pendingSend = [];
		// Incrementing request ID counter for this WebSocket
		this._lastRequestId = 0;
		/* Object of pending requests; keys are the request ID, values are
			Objects containing `resolve` and `reject` functions used to
			resolve the request's Promise. */
		this._pendingRequests = {};
		/* Object of WebSocketChannels (except `this` associated with this
			WebSocket; keys are the channel name. */
		this.channels = {};
		// Object containing user-assigned socket data
		this.data = {};
		// Bind this wrapper to the `socket` passed to the constructor
		this.socket = null;
		if(socket && socket.constructor) {
			this.bind(socket);
		}
	}

	bind(socket) {
		// Save the `socket` and add event listeners
		this.socket = socket;
		socket.onopen = () => {
			this._opened = true;
			debug("socket: onopen");
			// Send all pending messages
			for(var i = 0; i < this._pendingSend.length; i++) {
				if(this.isConnected) {
					debug("wrapper: Sending pending message:",
						this._pendingSend[i]);
					this.socket.send(this._pendingSend[i]);
				} else {
					break;
				}
			}
			this._pendingSend = this._pendingSend.slice(i);
		};
		socket.onmessage = (event) => {
			debug("socket: onmessage", event.data);
			this.emit("message", event.data, event);
			this._onMessage(event.data);
		};
		socket.onerror = (event) => {
			debug("socket: onerror", event);
			this.emit("error", event);
		};
		socket.onclose = (event) => {
			var opened = this._opened;
			this._opened = false;
			debug("socket: onclose", event);
			this.emit("disconnect", opened);
		};
		// If the socket is already open, send all pending messages now
		if(this.isConnected) {
			socket.onopen();
		}
	}

	// Rejects all pending requests and then clears the send queue
	abort() {
		for(var id in this._pendingRequests) {
			this._pendingRequests[id].reject(new Error("Request was aborted") );
		}
		this._pendingRequests = {};
		this._pendingSend = [];
	}

	// Returns a channel with the specified `namespace`
	of(namespace) {
		if(!this.channels[namespace]) {
			this.channels[namespace] = new WebSocketChannel(namespace, this);
		}
		return this.channels[namespace];
	}

	get isConnecting() {
		return this.socket && this.socket.readyState ===
			this.socket.constructor.CONNECTING;
	}

	get isConnected() {
		return this.socket && this.socket.readyState ===
			this.socket.constructor.OPEN;
	}

	send(data, ignoreMaxQueueSize) {
		if(this.isConnected) {
			debug("wrapper: Sending message:", data);
			this.socket.send(data);
		} else if(ignoreMaxQueueSize ||
			this._pendingSend.length < WebSocketWrapper.MAX_SEND_QUEUE_SIZE)
		{
			debug("wrapper: Queuing message:", data);
			this._pendingSend.push(data);
		} else {
			throw new Error("WebSocket is not connected and send queue is full");
		}
	}

	disconnect() {
		if(this.socket)
			this.socket.close.apply(this.socket, arguments);
	}

	// Called whenever the bound Socket receives a message
	_onMessage(msg) {
		try {
			msg = JSON.parse(msg);
			// If `msg` contains special ignore property, we'll ignore it
			if(msg["ws-wrapper"] === false)
				return;
			/* If `msg` does not have an `a` Array with at least 1 element,
				ignore the message because it is not a valid event/request */
			if(msg.a instanceof Array && msg.a.length >= 1 &&
				(msg.c || WebSocketChannel.NO_WRAP_EVENTS.indexOf(msg.a[0]) < 0) )
			{
				// Process inbound event/request
				var event = {
					"name": msg.a.shift(),
					"args": msg.a,
					"requestId": msg.i
				};
				var channel = msg.c ? this.channels[msg.c] : this;
				if(!channel) {
					if(msg.i >= 0) {
						this._sendReject(msg.i, new Error(
							`Channel '${msg.c}' does not exist`
						) );
					}
					debug(`wrapper: Event '${event.name}' ignored ` +
							`because channel '${msg.c}' does not exist.`);
				} else if(channel._emitter.emit(event.name, event) ) {
					debug(`wrapper: Event '${event.name}' sent to ` +
						"event listener");
				} else {
					if(msg.i >= 0) {
						this._sendReject(msg.i, new Error(
							"No event listener for '" + event.name + "'" +
							(msg.c ? " on channel '" + msg.c + "'" : "")
						) );
					}
					debug(`wrapper: Event '${event.name}' had no ` +
						"event listener");
				}
			} else if(this._pendingRequests[msg.i]) {
				debug("wrapper: Processing response for request", msg.i);
				// Process response to prior request
				if(msg.e !== undefined) {
					this._pendingRequests[msg.i].reject(new Error(msg.e) );
				} else {
					this._pendingRequests[msg.i].resolve(msg.d);
				}
				delete this._pendingRequests[msg.i];
			}
			// else ignore the message because it's not valid
		} catch(e) {
			// Non-JSON messages are ignored
			/* Note: It's also possible for uncaught exceptions from event
				handlers to end up here. */
		}
	}

	/* The following methods are called by a WebSocketChannel to send data
		to the Socket. */
	_sendEvent(channel, eventName, args, isRequest) {
		// Serialize data for sending over the socket
		var data = {"a": Array.prototype.slice.call(args)};
		if(channel != null) {
			data.c = channel;
		}
		var request;
		if(isRequest) {
			/* Unless we send petabytes of data using the same socket,
				we won't worry about `_lastRequestId` getting too big. */
			data.i = ++this._lastRequestId;
			// Return a Promise to the caller to be resolved later
			request = new Promise((resolve, reject) => {
				this._pendingRequests[this._lastRequestId] = {
					"resolve": resolve,
					"reject": reject
				};
			});
		}
		// Send the message
		this.send(JSON.stringify(data) );
		// Return the request, if needed
		return request;
	}

	_sendResolve(id, data) {
		this.send(JSON.stringify({
			"i": id,
			"d": data
		}), true /* ignore max queue length */);
	}

	_sendReject(id, err) {
		this.send(JSON.stringify({
			"i": id,
			"e": err ? (err.message || err) : null
		}), true /* ignore max queue length */);
	}

	get(key) {
		return this.data[key];
	}

	set(key, value) {
		this.data[key] = value;
	}
}

/* Maximum number of items in the send queue.  If a user tries to send more
	messages than this number while a WebSocket is not connected, errors will
	be thrown. */
WebSocketWrapper.MAX_SEND_QUEUE_SIZE = 10;

module.exports = WebSocketWrapper;