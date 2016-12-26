import { Injectable, NgZone, EventEmitter } from '@angular/core'
import { Logger, LogService } from 'services/log'
const exec = require('child-process-promise').exec
import * as crypto from 'crypto'
import * as ptyjs from 'pty.js'


export interface SessionRecoveryProvider {
    list(): Promise<any[]>
    getRecoveryCommand(item: any): string
    getNewSessionCommand(command: string): string
}

export class NullSessionRecoveryProvider implements SessionRecoveryProvider {
    list(): Promise<any[]> {
        return Promise.resolve([])
    }

    getRecoveryCommand(_: any): string {
        return null
    }

    getNewSessionCommand(command: string) {
        return command
    }
}

export class ScreenSessionRecoveryProvider implements SessionRecoveryProvider {
    list(): Promise<any[]> {
        return exec('screen -ls').then((result) => {
            return result.stdout.split('\n')
                .filter((line) => /\bterm-tab-/.exec(line))
                .map((line) => line.trim().split('.')[0])
        }).catch(() => {
            return []
        })
    }

    getRecoveryCommand(item: any): string {
        return `screen -r ${item}`
    }

    getNewSessionCommand(command: string): string {
        const id = crypto.randomBytes(8).toString('hex')
        return `screen -U -S term-tab-${id} -- ${command}`
    }
}


export interface SessionOptions {
    name?: string,
    command: string,
    cwd?: string,
    env?: string,
}

export class Session {
    open: boolean
    name: string
    pty: any
    dataAvailable = new EventEmitter()
    closed = new EventEmitter()
    destroyed = new EventEmitter()

    constructor (options: SessionOptions) {
        this.name = options.name
        console.log('Spawning', options.command)
        this.pty = ptyjs.spawn('sh', ['-c', options.command], {
            //name: 'xterm-color',
            name: 'xterm-256color',
            cols: 80,
            rows: 30,
            cwd: options.cwd || process.env.HOME,
            env: options.env || process.env,
        })

        this.open = true

        this.pty.on('data', (data) => {
            this.dataAvailable.emit(data)
        })

        this.pty.on('close', () => {
            this.open = false
            this.closed.emit()
        })
    }

    resize (columns, rows) {
        this.pty.resize(columns, rows)
    }

    write (data) {
        this.pty.write(data)
    }

    sendSignal (signal) {
        this.pty.kill(signal)
    }

    close () {
        this.open = false
        this.closed.emit()
        this.pty.end()
    }

    gracefullyDestroy () {
        return new Promise((resolve) => {
            this.sendSignal('SIGTERM')
            if (!this.open) {
                resolve()
                this.destroy()
            } else {
                setTimeout(() => {
                    if (this.open) {
                        this.sendSignal('SIGKILL')
                        this.destroy()
                    }
                    resolve()
                }, 1000)
            }
        })
    }

    destroy () {
        if (open) {
            this.close()
        }
        this.destroyed.emit()
        this.pty.destroy()
    }
}

@Injectable()
export class SessionsService {
    sessions: {[id: string]: Session} = {}
    logger: Logger
    private lastID = 0
    recoveryProvider: SessionRecoveryProvider

    constructor(
        private zone: NgZone,
        log: LogService,
    ) {
        this.logger = log.create('sessions')
        this.recoveryProvider = new ScreenSessionRecoveryProvider()
        //this.recoveryProvider = new NullSessionRecoveryProvider()
    }

    createNewSession (options: SessionOptions) : Session {
        options.command = this.recoveryProvider.getNewSessionCommand(options.command)
        return this.createSession(options)
    }

    createSession (options: SessionOptions) : Session {
        this.lastID++
        options.name = `session-${this.lastID}`
        let session = new Session(options)
        const destroySubscription = session.destroyed.subscribe(() => {
            delete this.sessions[session.name]
            destroySubscription.unsubscribe()
        })
        this.sessions[session.name] = session
        return session
    }

    recoverAll () : Promise<Session[]> {
        return <Promise<Session[]>>(this.recoveryProvider.list().then((items) => {
            return this.zone.run(() => {
                return items.map((item) => {
                    const command = this.recoveryProvider.getRecoveryCommand(item)
                    return this.createSession({command})
                })
            })
        }))
    }
}
