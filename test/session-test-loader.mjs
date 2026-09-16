const obsidianSource = `
export class TFile {
  constructor(path) {
    this.path = path;
    this.basename = path.split('/').pop().replace(/\\.md$/, '');
  }
}

export class Notice {
  setMessage() {}
  hide() {}
}

export function normalizePath(path) {
  return path;
}
`;

const websocketSource = `
export class WebsocketProvider {
  constructor(serverUrl, roomName, doc) {
    this.serverUrl = serverUrl;
    this.roomName = roomName;
    this.doc = doc;
    this.wsconnected = true;
    this.wsconnecting = false;
    this.listeners = new Map();
    globalThis[Symbol.for('notecolab.test.websocketProvider')] = this;
    const initialContent = globalThis[Symbol.for('notecolab.test.initialYText')];
    if (typeof initialContent === 'string' && initialContent) {
      doc.getText('content').insert(0, initialContent);
    }
    delete globalThis[Symbol.for('notecolab.test.initialYText')];
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) || new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event, listener) {
    this.listeners.get(event)?.delete(listener);
  }

  async emit(event, value) {
    await Promise.all(Array.from(this.listeners.get(event) || [], listener => listener(value)));
  }

  destroy() {}
}
`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'obsidian') {
    return {
      url: `data:text/javascript,${encodeURIComponent(obsidianSource)}`,
      shortCircuit: true,
    };
  }
  if (specifier === 'y-websocket') {
    return {
      url: `data:text/javascript,${encodeURIComponent(websocketSource)}`,
      shortCircuit: true,
    };
  }
  if (specifier.startsWith('.') && !specifier.match(/\.[a-z]+$/i)) {
    return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
}
