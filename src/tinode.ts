import { ConnectionOptions, Connection, LPConnection, WSConnection } from './connection';
import { getBrowserInfo, mergeObj } from './utilities';
import { AppSettings, AppInfo } from './constants';
import { Packet, PacketTypes } from './models/packet';
import { HiPacketData, AccPacketData, LoginPacketData } from './models/packet-data';

export class Tinode {
    /**
     * Connection config used to initiate a connection
     */
    private connectionConfig: ConnectionOptions;
    /**
     * Client's platform
     */
    private hardwareOS = 'Undefined';
    /**
     * Client's language
     */
    private humanLanguage = 'en-US';
    /**
     * Specified platform by user
     */
    private platform = 'Undefined';
    /**
     * Specified app name by user
     */
    private appName = 'Undefined';
    /**
     * If this code is running on a browser, which one?
     */
    private browser = '';
    /**
     * Logging to console enabled
     */
    private loggingEnabled = false;
    /**
     * When logging, trip long strings (base64-encoded images) for readability
     */
    private trimLongStrings = false;
    /**
     * UID of the currently authenticated user.
     */
    private myUserID = null;
    /**
     * Status of connection: authenticated or not.
     */
    private authenticated = false;
    /**
     * Login used in the last successful basic authentication
     */
    private login = null;
    /**
     * Token which can be used for login instead of login/password.
     */
    private authToken = null;
    /**
     * Counter of received packets
     */
    private inPacketCount = 0;
    /**
     * Counter for generating unique message IDs
     */
    private messageId = Math.floor((Math.random() * 0xFFFF) + 0xFFFF);
    /**
     * Information about the server, if connected
     */
    private serverInfo = null;
    /**
     * Push notification token. Called deviceToken for consistency with the Android SDK.
     */
    private deviceToken = null;
    /**
     * Cache of pending promises by message id.
     */
    private pendingPromises = {};
    /**
     * A connection object
     */
    private connection: Connection = null;
    /**
     * Tinode's cache of objects
     */
    private cache = {};
    /**
     * Stores interval to clear later
     */
    private checkExpiredPromisesInterval: any;

    constructor(appName: string, platform: string, connectionConfig: ConnectionOptions) {
        this.connectionConfig = connectionConfig;

        if (appName) {
            this.appName = appName;
        }

        if (platform) {
            this.platform = platform;
        }

        if (typeof navigator !== 'undefined') {
            this.browser = getBrowserInfo(navigator.userAgent, navigator.product);
            this.hardwareOS = navigator.platform;
            // This is the default language. It could be changed by client.
            this.humanLanguage = navigator.language || 'en-US';
        }

        if (connectionConfig.transport === 'lp') {
            this.connection = new LPConnection(connectionConfig);
        } else if (connectionConfig.transport === 'ws') {
            this.connection = new WSConnection(connectionConfig);
        } else {
            throw new Error('Invalid transport method is selected! It can be "lp" or "ws"');
        }

        if (this.connection) {
            this.connection.logger = this.logger;
        }

        setInterval(() => {
            this.checkExpiredPromises();
        }, AppSettings.EXPIRE_PROMISES_PERIOD);
    }

    /**
     * Console logger
     * @param str - String to log
     * @param args - arguments
     */
    private logger(str: string, ...args: any[]) {
        if (this.loggingEnabled) {
            const d = new Date();
            const dateString = ('0' + d.getUTCHours()).slice(-2) + ':' +
                ('0' + d.getUTCMinutes()).slice(-2) + ':' +
                ('0' + d.getUTCSeconds()).slice(-2) + '.' +
                ('00' + d.getUTCMilliseconds()).slice(-3);

            console.log('[' + dateString + ']', str, args.join(' '));
        }
    }

    /**
     * Put an object into cache
     * @param type - cache type
     * @param name - cache name
     * @param obj - cache object
     */
    private cachePut(type: string, name: string, obj: any) {
        this.cache[type + ':' + name] = obj;
    }

    /**
     * Get an object from cache
     * @param type - cache type
     * @param name - cache name
     */
    private cacheGet(type: string, name: string) {
        return this.cache[type + ':' + name];
    }

    /**
     * Delete an object from cache
     * @param type - cache type
     * @param name - cache name
     */
    private cacheDel(type: string, name: string) {
        delete this.cache[type + ':' + name];
    }

    /**
     * Enumerate all items in cache, call func for each item.
     * Enumeration stops if func returns true.
     * @param func - function to call for each item
     * @param context - function context
     */
    private cacheMap(func: any, context: any) {
        for (const idx in this.cache) {
            if (func(this.cache[idx], idx, context)) {
                break;
            }
        }
    }

    /**
     * REVIEW: Add Types
     * Make limited cache management available to topic.
     * Caching user.public only. Everything else is per-topic.
     * @param topic - Topic to attach cache
     */
    private attachCacheToTopic(topic: any) {
        topic._tinode = this;

        topic._cacheGetUser = (uid) => {
            const pub = this.cacheGet('user', uid);
            if (pub) {
                return {
                    user: uid,
                    public: mergeObj({}, pub)
                };
            }
            return undefined;
        };
        topic._cachePutUser = (uid, user) => {
            return this.cachePut('user', uid, mergeObj({}, user.public));
        };
        topic._cacheDelUser = (uid) => {
            return this.cacheDel('user', uid);
        };
        topic._cachePutSelf = () => {
            return this.cachePut('topic', topic.name, topic);
        };
        topic._cacheDelSelf = () => {
            return this.cacheDel('topic', topic.name);
        };
    }

    /**
     * Resolve or reject a pending promise.
     * Unresolved promises are stored in _pendingPromises.
     */
    private execPromise(id: number, code: number, onOK: any, errorText: string) {
        const callbacks = this.pendingPromises[id];
        if (callbacks) {
            delete this.pendingPromises[id];
            if (code >= 200 && code < 400) {
                if (callbacks.resolve) {
                    callbacks.resolve(onOK);
                }
            } else if (callbacks.reject) {
                callbacks.reject(new Error(errorText + ' (' + code + ')'));
            }
        }
    }

    /**
     * Stored callbacks will be called when the response packet with this Id arrives
     * @param id - Id of new promise
     */
    makePromise(id: number) {
        let promise = null;
        if (id) {
            promise = new Promise((resolve, reject) => {
                this.pendingPromises[id] = {
                    resolve,
                    reject,
                    ts: new Date(),
                };
            });
        }
        return promise;
    }

    /**
     * Reject promises which have not been resolved for too long.
     */
    private checkExpiredPromises(): void {
        const err = new Error('Timeout (504)');
        const expires = new Date(new Date().getTime() - AppSettings.EXPIRE_PROMISES_TIMEOUT);
        for (const id in this.pendingPromises) {
            if (id) {
                const callbacks = this.pendingPromises[id];
                if (callbacks && callbacks.ts < expires) {
                    this.logger('Promise expired', id);
                    delete this.pendingPromises[id];
                    if (callbacks.reject) {
                        callbacks.reject(err);
                    }
                }
            }
        }
    }

    /**
     * Generates unique message IDs
     */
    private getNextUniqueId(): string {
        return (this.messageId !== 0) ? '' + this.messageId++ : undefined;
    }

    /**
     * Get User Agent string
     */
    private getUserAgent(): string {
        return this.appName + ' (' + (this.browser ? this.browser + '; ' : '') + this.hardwareOS + '); ' + AppInfo.LIBRARY;
    }

    /**
     * Generator of packets stubs
     */
    initPacket(type: PacketTypes, topic: string): Packet<any> {
        switch (type) {
            case PacketTypes.Hi:
                const hiData: HiPacketData = {
                    id: this.getNextUniqueId(),
                    ver: AppInfo.VERSION,
                    ua: this.getUserAgent(),
                    dev: this.deviceToken,
                    lang: this.humanLanguage,
                    platf: this.platform,
                };
                return new Packet(type, hiData);

            case PacketTypes.Acc:
                const accData: AccPacketData = {
                    id: this.getNextUniqueId(),
                    user: null,
                    scheme: null,
                    secret: null,
                    login: false,
                    tags: null,
                    desc: {},
                    cred: {},
                };
                return new Packet(type, accData);

            case PacketTypes.Login:
                const loginData: LoginPacketData = {
                    id: this.getNextUniqueId(),
                    scheme: null,
                    secret: null,
                };
                return new Packet(type, loginData);

            default:
                throw new Error('Unknown packet type requested: ' + type);
        }
    }
}
