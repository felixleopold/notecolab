import { Modal, type App } from 'obsidian';

/** Explicit reseed of an encrypted note whose live history is missing (docs/LIVE-E2E-ENCRYPTION.md §5.1). */
export class RepairLiveHistoryModal extends Modal {
  constructor(app: App, private readonly onConfirm: () => void) {
    super(app);
  }

  onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: 'Repair encrypted live history?' });
    this.contentEl.createEl('p', {
      text: 'NoteColab couldn’t load this note’s encrypted live history from the server or any collaborator. Repairing starts a new history from the last saved text.',
    });
    this.contentEl.createEl('p', {
      text: 'If a collaborator later returns with the old history, their copy and the repaired one are combined and some text may appear twice. Check the note then; earlier versions stay in version history.',
    });
    const row = this.contentEl.createDiv();
    row.setCssStyles({ display: 'flex', justifyContent: 'flex-end', gap: '8px' });
    row.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    const repair = row.createEl('button', { text: 'Repair from saved text' });
    repair.setCssStyles({ background: 'var(--interactive-accent)', color: 'var(--text-on-accent)' });
    repair.addEventListener('click', () => {
      this.close();
      this.onConfirm();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
