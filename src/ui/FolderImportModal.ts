import { Modal, Setting, type App } from 'obsidian';
import type { FolderManifest } from '../share/folderManifest';
import type { FolderShareState } from '../share/folderShare';
import type { FolderSubscription } from '../types';

export class FolderImportLinkModal extends Modal {
  private link = '';

  constructor(app: App, private readonly onLoad: (link: string) => void) {
    super(app);
  }

  onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: 'Import a shared folder' });
    new Setting(this.contentEl)
      .setName('Folder link')
      .setDesc('The link opens an encrypted index. You will preview its contents before any note is imported.')
      .addText((text) => text.setPlaceholder('https://notecolab.com/s/...').onChange((value) => { this.link = value.trim(); }));
    new Setting(this.contentEl).addButton((button) => button
      .setButtonText('Preview')
      .setCta()
      .onClick(() => {
        if (!this.link) return;
        this.close();
        this.onLoad(this.link);
      }));
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class FolderSubscriptionPromptModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private readonly folderName: string,
    private readonly onDecision: (subscribe: boolean) => void,
  ) {
    super(app);
  }

  onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: 'Watch for new shared notes?' });
    this.contentEl.createEl('p', {
      text: `NoteColab can periodically check the encrypted “${this.folderName}” index. New files are never imported until you approve a preview.`,
    });
    const row = this.contentEl.createDiv();
    row.setCssStyles({ display: 'flex', justifyContent: 'flex-end', gap: '8px' });
    const once = row.createEl('button', { text: 'Import once' });
    once.addEventListener('click', () => this.decide(false));
    const subscribe = row.createEl('button', { text: 'Watch for new notes' });
    subscribe.setCssStyles({ background: 'var(--interactive-accent)', color: 'var(--text-on-accent)' });
    subscribe.addEventListener('click', () => this.decide(true));
  }

  private decide(subscribe: boolean) {
    if (this.decided) return;
    this.decided = true;
    this.onDecision(subscribe);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
    if (!this.decided) {
      this.decided = true;
      this.onDecision(false);
    }
  }
}

export type FolderUpdateDecision = 'import' | 'later' | 'unsubscribe';

export class FolderUpdatePreviewModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private readonly folderName: string,
    private readonly paths: string[],
    private readonly onDecision: (decision: FolderUpdateDecision) => void,
  ) {
    super(app);
  }

  onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: `New notes in “${this.folderName}”` });
    this.contentEl.createEl('p', { text: `${this.paths.length} new shared file${this.paths.length === 1 ? '' : 's'} are available.` });
    const list = this.contentEl.createEl('ul');
    for (const path of this.paths.slice(0, 12)) list.createEl('li', { text: path });
    if (this.paths.length > 12) list.createEl('li', { text: `…and ${this.paths.length - 12} more` });
    const row = this.contentEl.createDiv();
    row.setCssStyles({ display: 'flex', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap' });
    for (const [label, decision] of [
      ['Stop watching', 'unsubscribe'],
      ['Later', 'later'],
      ['Import new notes', 'import'],
    ] as const) {
      const button = row.createEl('button', { text: label });
      if (decision === 'import') button.setCssStyles({ background: 'var(--interactive-accent)', color: 'var(--text-on-accent)' });
      button.addEventListener('click', () => this.decide(decision));
    }
  }

  private decide(decision: FolderUpdateDecision) {
    if (this.decided) return;
    this.decided = true;
    this.onDecision(decision);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
    if (!this.decided) {
      this.decided = true;
      this.onDecision('later');
    }
  }
}

export class FolderSubscriptionsModal extends Modal {
  constructor(
    app: App,
    private readonly subscriptions: FolderSubscription[],
    private readonly ownedFolders: FolderShareState[],
    private readonly onUnsubscribe: (manifestUrl: string) => void,
    private readonly onOwnerWatchChange: (state: FolderShareState, watching: boolean) => void,
  ) {
    super(app);
  }

  onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: 'Watched shared folders' });
    if (!this.subscriptions.length && !this.ownedFolders.length) {
      this.contentEl.createEl('p', { text: 'No shared folders are being watched.' });
      return;
    }
    if (this.ownedFolders.length) {
      this.contentEl.createEl('h3', { text: 'Folders you publish' });
      this.contentEl.createEl('p', {
        text: 'While watching is on, new Markdown files are automatically published. Stopping pauses folder-index updates and new-file publication. Already-shared notes keep their own sync settings and their links remain active.',
      });
      for (const state of this.ownedFolders) {
        const watching = state.watching !== false;
        new Setting(this.contentEl)
          .setName(state.folderPath)
          .setDesc(watching ? 'Automatically publishes additions, edits, renames, and index removals.' : 'Folder watching is paused. Existing notes keep their own sync settings.')
          .addButton((button) => button
            .setButtonText(watching ? 'Stop watching' : 'Resume watching')
            .onClick(() => {
              this.onOwnerWatchChange(state, !watching);
              button.setDisabled(true).setButtonText(watching ? 'Stopped' : 'Resumed');
            }));
      }
    }
    if (this.subscriptions.length) this.contentEl.createEl('h3', { text: 'Folders shared with you' });
    for (const subscription of this.subscriptions) {
      new Setting(this.contentEl)
        .setName(subscription.rootPath)
        .setDesc(`Checks ${new URL(subscription.manifestUrl).origin}. New notes always require approval.`)
        .addButton((button) => button.setButtonText('Stop watching').onClick(() => {
          this.onUnsubscribe(subscription.manifestUrl);
          button.setDisabled(true).setButtonText('Stopped');
        }));
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class FolderImportPreviewModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private readonly manifest: FolderManifest,
    private readonly onDecision: (accepted: boolean) => void,
  ) {
    super(app);
  }

  private decide(accepted: boolean) {
    if (this.decided) return;
    this.decided = true;
    this.onDecision(accepted);
    this.close();
  }

  onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: `Import “${this.manifest.name}”?` });
    this.contentEl.createEl('p', {
      text: `${this.manifest.entries.length} Markdown file${this.manifest.entries.length === 1 ? '' : 's'} will be imported into Shared Folders with their relative structure. Existing imports are skipped, so retrying is safe.`,
    });
    const list = this.contentEl.createEl('ul');
    for (const entry of this.manifest.entries.slice(0, 12)) list.createEl('li', { text: entry.path });
    if (this.manifest.entries.length > 12) list.createEl('li', { text: `…and ${this.manifest.entries.length - 12} more` });
    const row = this.contentEl.createDiv();
    row.setCssStyles({ display: 'flex', justifyContent: 'flex-end', gap: '8px' });
    const cancel = row.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.decide(false));
    const accept = row.createEl('button', { text: 'Import folder' });
    accept.setCssStyles({ background: 'var(--interactive-accent)', color: 'var(--text-on-accent)' });
    accept.addEventListener('click', () => this.decide(true));
  }

  onClose() {
    this.contentEl.empty();
    if (!this.decided) {
      this.decided = true;
      this.onDecision(false);
    }
  }
}
