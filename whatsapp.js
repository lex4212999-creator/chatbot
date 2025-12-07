// whatsapp.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const path = require('path');
const EventEmitter = require('events');

class WhatsAppService extends EventEmitter {
  constructor(sessionPath) {
    super();
    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: sessionPath || path.join(__dirname, 'data', 'session'),
      }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    });

    this._bindEvents();
    this.client.initialize();
  }

  _bindEvents() {
    this.client.on('qr', (qr) => {
      this.emit('qr', qr);
    });

    this.client.on('authenticated', () => {
      this.emit('status', { state: 'authenticated' });
    });

    this.client.on('ready', () => {
      this.emit('status', { state: 'ready' });
    });

    this.client.on('auth_failure', (msg) => {
      this.emit('status', { state: 'auth_failure', msg });
    });

    this.client.on('disconnected', (reason) => {
      this.emit('status', { state: 'disconnected', reason });
      // optional: this.client.initialize(); // auto re-init
    });
  }

  onMessage(handler) {
    this.client.on('message', handler);
  }

  async sendMessage(chatId, text) {
    return this.client.sendMessage(chatId, text);
  }
}

module.exports = { WhatsAppService };
