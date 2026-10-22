import { Modal, Notice, Setting, type App } from 'obsidian';

/**
 * Copy text and announce success only after the clipboard accepted it. When
 * clipboard access is blocked, show the text in a selectable field instead.
 */
export async function copyToClipboard(app: App, text: string, successMessage: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    new Notice(successMessage);
    return true;
  } catch (error) {
    console.error('NoteColab: clipboard write failed', error);
    new ManualCopyModal(app, text).open();
    return false;
  }
}

class ManualCopyModal extends Modal {
  private readonly text: string;

  constructor(app: App, text: string) {
    super(app);
    this.text = text;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Copy manually' });
    contentEl.createEl('p', { text: 'Clipboard access was blocked. Select the text below and copy it.' });
    const field = contentEl.createEl('textarea', {
      attr: { readonly: 'true', rows: '3', 'aria-label': 'Text to copy' },
    });
    field.value = this.text;
    field.setCssStyles({ width: '100%', resize: 'none', fontFamily: 'var(--font-monospace)' });
    new Setting(contentEl).addButton((button) => button.setButtonText('Done').setCta().onClick(() => this.close()));
    field.focus();
    field.select();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
