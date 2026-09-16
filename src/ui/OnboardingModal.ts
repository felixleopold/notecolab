import { Modal, Notice, type App } from 'obsidian';

const SECURITY_URL = 'https://notecolab.com/security';
const ONBOARDING_STEPS = 4;

interface ConnectionResult {
  ok: boolean;
  error?: string;
}

interface OnboardingOptions {
  serverUrl: string;
  connected: boolean;
  onConnect: () => Promise<ConnectionResult>;
  onShare: () => void;
  onDone: (completed: boolean) => Promise<void>;
}

export class OnboardingModal extends Modal {
  private step = 1;
  private connected: boolean;
  private completed = false;
  private handingOffToShare = false;
  private connecting = false;
  private connectionError = '';

  constructor(app: App, private options: OnboardingOptions) {
    super(app);
    this.connected = options.connected;
  }

  onOpen(): void {
    this.modalEl.setCssStyles({ width: '560px', maxWidth: '90vw' });
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.handingOffToShare) void this.options.onDone(this.completed);
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.setCssStyles({ padding: '8px 8px 4px' });

    contentEl.createEl('div', {
      text: `Step ${this.step} of ${ONBOARDING_STEPS}`,
      cls: 'setting-item-description',
    }).setCssStyles({ marginBottom: '8px', fontWeight: '600' });

    if (this.step === 1) this.renderConnection();
    if (this.step === 2) this.renderInstructions();
    if (this.step === 3) this.renderPrivacy();
    if (this.step === 4) this.renderFirstShare();

    const footer = contentEl.createDiv();
    footer.setCssStyles({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginTop: '24px' });

    const exit = footer.createEl('button', { text: this.step === 1 ? 'Not now' : 'Finish later' });
    exit.addEventListener('click', () => this.close());

    const controls = footer.createDiv();
    controls.setCssStyles({ display: 'flex', gap: '8px' });
    if (this.step > 1) {
      const back = controls.createEl('button', { text: 'Back' });
      back.addEventListener('click', () => { this.step -= 1; this.render(); });
    }

    if (this.step === 1) {
      const connect = controls.createEl('button', {
        text: this.connected ? 'Continue' : this.connecting ? 'Connecting…' : `Connect to ${this.serverName()}`,
        cls: 'mod-cta',
      });
      connect.disabled = this.connecting;
      connect.addEventListener('click', () => { void this.connectAndContinue(); });
    } else if (this.step < ONBOARDING_STEPS) {
      const next = controls.createEl('button', { text: 'Continue', cls: 'mod-cta' });
      next.addEventListener('click', () => { this.step += 1; this.render(); });
    } else {
      this.renderFinalAction(controls);
    }
  }

  private renderConnection(): void {
    this.contentEl.createEl('h2', { text: 'Share notes without leaving Obsidian' });
    this.contentEl.createEl('p', {
      text: 'Note Colab can publish a note for reading, invite specific collaborators, or let people edit with you in Obsidian and the browser.',
    });
    this.contentEl.createEl('p', {
      text: `Connecting creates an identity on ${this.serverName()}. No email address or password is required. Nothing is shared until you choose a note and confirm its access settings.`,
    });

    const status = this.contentEl.createDiv();
    status.setCssStyles({ marginTop: '18px', padding: '12px 14px', border: '1px solid var(--background-modifier-border)', borderRadius: '8px', background: 'var(--background-secondary)' });
    status.createEl('strong', { text: this.connected ? 'Connected' : 'Not connected yet' });
    status.createEl('div', {
      text: this.connected ? this.options.serverUrl : `Server: ${this.options.serverUrl}`,
      cls: 'setting-item-description',
    }).setCssStyles({ marginTop: '4px' });
    if (this.connectionError) {
      status.createEl('div', { text: this.connectionError }).setCssStyles({ marginTop: '8px', color: 'var(--text-error)' });
    }
  }

  private renderInstructions(): void {
    this.contentEl.createEl('h2', { text: 'Share any Markdown note' });
    this.contentEl.createEl('p', { text: 'The command palette is the quickest path, no matter how your workspace is arranged.' });
    const list = this.contentEl.createEl('ol');
    list.setCssStyles({ margin: '18px 0 0', paddingLeft: '24px' });
    list.createEl('li', { text: 'Open the note you want to share.' });
    const palette = list.createEl('li');
    palette.appendText('Open the command palette with ');
    palette.createEl('kbd', { text: 'Ctrl/Cmd + P' });
    palette.appendText('.');
    const command = list.createEl('li');
    command.appendText('Run ');
    command.createEl('strong', { text: 'Note Colab: Share note' });
    command.appendText('.');
    list.createEl('li', { text: 'Choose who can read or edit, then confirm the share.' });
    for (const item of Array.from(list.children)) (item as HTMLElement).setCssStyles({ marginBottom: '10px', paddingLeft: '4px' });
  }

  private renderPrivacy(): void {
    this.contentEl.createEl('h2', { text: 'Know what leaves your vault' });
    this.contentEl.createEl('p', {
      text: 'Current clients encrypt stored Markdown, titles, and supported images before upload. The note key stays after # in the share link and is not sent in ordinary HTTP requests.',
    });
    this.contentEl.createEl('p', {
      text: 'During live collaboration, decrypted Yjs text is visible to the relay while the room is active. The server also sees operational metadata. Note Colab is not wholly zero-knowledge or end-to-end encrypted.',
    });
    const details = this.contentEl.createEl('button', { text: 'Read the security model' });
    details.setCssStyles({ marginTop: '8px' });
    details.addEventListener('click', () => window.open(SECURITY_URL, '_blank', 'noopener,noreferrer'));
  }

  private renderFirstShare(): void {
    const file = this.app.workspace.getActiveFile();
    this.contentEl.createEl('h2', { text: 'Share your first note' });
    if (!file) {
      this.contentEl.createEl('p', { text: 'No Markdown note is open. Finish this guide, open a note, then use the command palette steps you just learned.' });
      return;
    }
    this.contentEl.createEl('p', { text: 'You will choose the audience and expiry before Note Colab uploads anything or creates a link.' });
    const note = this.contentEl.createDiv();
    note.setCssStyles({ marginTop: '18px', padding: '12px 14px', border: '1px solid var(--background-modifier-border)', borderRadius: '8px', background: 'var(--background-secondary)' });
    note.createEl('span', { text: 'Active note', cls: 'setting-item-description' });
    note.createEl('strong', { text: file.path }).setCssStyles({ display: 'block', marginTop: '3px' });
  }

  private renderFinalAction(container: HTMLElement): void {
    const file = this.app.workspace.getActiveFile();
    if (file) {
      const share = container.createEl('button', { text: `Share ${file.basename}`, cls: 'mod-cta' });
      share.addEventListener('click', () => {
        this.handingOffToShare = true;
        this.close();
        this.options.onShare();
      });
      return;
    }
    const finish = container.createEl('button', { text: 'Finish', cls: 'mod-cta' });
    finish.addEventListener('click', () => { this.completed = true; this.close(); });
  }

  private async connectAndContinue(): Promise<void> {
    if (!this.connected) {
      this.connecting = true;
      this.connectionError = '';
      this.render();
      const result = await this.options.onConnect();
      this.connecting = false;
      if (!result.ok) {
        this.connectionError = result.error || 'Could not connect. Check the server in Note Colab settings and try again.';
        new Notice(this.connectionError);
        this.render();
        return;
      }
      this.connected = true;
    }
    this.step = 2;
    this.render();
  }

  private serverName(): string {
    try {
      return new URL(this.options.serverUrl).host;
    } catch {
      return this.options.serverUrl;
    }
  }
}
