
import { ClientRequest, IncomingMessage } from 'http';

type Time = [number, number];

interface TimerResult {
	duration?: string;
	queued?: string;
	dnsLookup?: string;
	tcpConnection?: string;
	tlsHandshake?: string;
	timeToFirstByte?: string;
	contentDownload?: string;
}

const nanosecondsPerMillisecond = 10e5;
const oneMinute = 60;
const oneHour = 60 * 60;

export class HttpTimer {
	protected enqueued: Time;
	protected started: Time;
	protected dnsLookupComplete: Time;
	protected tcpConnectionEstablished: Time;
	protected tlsHandshakeComplete: Time;
	protected firstByteRecieved: Time;
	protected completed: Time;

	constructor(
		protected readonly req: ClientRequest,
		protected readonly requestId: number
	) {
		this.enqueued = process.hrtime();

		this.req.on('socket', (socket) => {
			this.started = process.hrtime();

			socket.on('lookup', () => {
				this.dnsLookupComplete = process.hrtime();
			});

			socket.on('connect', () => {
				this.tcpConnectionEstablished = process.hrtime();
			});

			socket.on('secureConnect', () => {
				this.tlsHandshakeComplete = process.hrtime();
			})
		});

		this.req.on('error', () => {
			this.completed = process.hrtime();
		});
	}

	onResponse(res: IncomingMessage) {
		res.once('readable', () => {
			this.firstByteRecieved = process.hrtime();
		});

		res.on('end', () => {
			this.completed = process.hrtime();
		});
	}

	durations() : TimerResult {
		const result: TimerResult = { };

		if (this.enqueued && this.completed) {
			result.duration = formatDuration(diff(this.enqueued, this.completed));
		}

		if (this.enqueued && this.started) {
			result.queued = formatDuration(diff(this.enqueued, this.started));
		}

		if (this.started && this.dnsLookupComplete) {
			result.dnsLookup = formatDuration(diff(this.started, this.dnsLookupComplete));
		}

		if (this.dnsLookupComplete && this.tcpConnectionEstablished) {
			result.tcpConnection = formatDuration(diff(this.dnsLookupComplete, this.tcpConnectionEstablished));
		}

		const ready = this.tlsHandshakeComplete || this.tcpConnectionEstablished;

		if (this.tcpConnectionEstablished && this.tlsHandshakeComplete) {
			result.tlsHandshake = formatDuration(diff(this.tcpConnectionEstablished, this.tlsHandshakeComplete));
		}

		if (ready && this.firstByteRecieved) {
			result.timeToFirstByte = formatDuration(diff(ready, this.firstByteRecieved));
		}

		if (this.firstByteRecieved && this.completed) {
			result.contentDownload = formatDuration(diff(this.firstByteRecieved, this.completed));
		}

		return result;
	}
}

const diff = (first: Time, second: Time) : Time => {
	return [
		second[0] - first[0],
		second[1] - first[1]
	];
};

/**
 * Returns a formatted duration string from a `process.hrtime()` result. Output can look like
 * "4.56789ms", "3sec 4.56789ms", "2min 3sec 4.56789ms", or "1hr 2min 3sec 4.56789ms"
 */
export const formatDuration = ([ wholeSeconds, nanoseconds ]: [ number, number ]) : string => {
	const milliseconds = `${(nanoseconds / nanosecondsPerMillisecond).toPrecision(6)}ms`;

	if (wholeSeconds < 1) {
		return milliseconds;
	}

	if (wholeSeconds < oneMinute) {
		return `${wholeSeconds}sec ${milliseconds}`;
	}

	if (wholeSeconds < oneHour) {
		const minutes = Math.floor(wholeSeconds / oneMinute);
		const remainingSeconds = wholeSeconds % oneMinute;

		return `${minutes}min ${remainingSeconds}sec ${milliseconds}`;
	}

	const hours = Math.floor(wholeSeconds / oneHour);
	const remainingMinutes = Math.floor(wholeSeconds % oneHour / oneMinute);
	const remainingSeconds = Math.floor(wholeSeconds % oneHour % oneMinute);

	return `${hours}hr ${remainingMinutes}min ${remainingSeconds}sec ${milliseconds}`;
};
