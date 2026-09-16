const obsidianSource = `
export class TFile {
  constructor(path) {
    this.path = path;
    this.name = path.split('/').pop();
    this.basename = this.name.replace(/\\.md$/, '');
  }
}
export class TFolder { constructor(path) { this.path = path; } }
export class Modal {}
export class Notice { setMessage() {} hide() {} }
export function normalizePath(path) { return path.replace(/\\\\/g, '/').replace(/^\\.\\//, '').replace(/\\/+/g, '/'); }
`;

const websocketSource = 'export class WebsocketProvider {}';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'obsidian') {
    return { url: `data:text/javascript,${encodeURIComponent(obsidianSource)}`, shortCircuit: true };
  }
  if (specifier === 'y-websocket') {
    return { url: `data:text/javascript,${encodeURIComponent(websocketSource)}`, shortCircuit: true };
  }
  if (specifier.startsWith('.') && !specifier.match(/\.[a-z]+$/i)) {
    return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
}
