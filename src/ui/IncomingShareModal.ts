import { Modal, type App } from 'obsidian';

export type ShareDecision = 'accept' | 'deny' | 'later';

export interface IncomingShareInfo {
  /** Display name for the sender (contact name, or a shortened UID). */
  senderName: string;
  /** The full sender UID — shown so the recipient can verify who shared. */
  senderUid: string;
  /** Title of the note being shared. */
  title: string;
  /** Determines whether the imported note is a mirror or an editable sync. */
  accessMode: 'public_edit' | 'invited_edit' | 'read_only';
}

/**
 * Popup shown when someone shares a note with the user's UID. Lets the
 * recipient explicitly accept (import) or deny the share instead of it being
 * imported silently — see issue #5.
 *
 * The decision callback always fires exactly once: 'accept' or 'deny' on a
 * button click, or 'later' if the modal is dismissed without choosing.
 */
export class IncomingShareModal extends Modal {
  private info: IncomingShareInfo;
  private onDecision: (decision: ShareDecision) => void;
  private decided = false;

  constructor(app: App, info: IncomingShareInfo, onDecision: (decision: ShareDecision) => void) {
    super(app);
    this.info = info;
    this.onDecision = onDecision;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Note shared with you' });

    const desc = contentEl.createDiv();
    desc.setCssStyles({ marginBottom: '16px', lineHeight: '1.5' });

    const intro = desc.createEl('p');
    intro.appendText(`${this.info.senderName} wants to share `);
    intro.createEl('strong', { text: `"${this.info.title}"` });
    intro.appendText(' with you.');

    // Sender identity box — show the UID the note was shared to/from so the
    // recipient can confirm it's someone they trust before importing.
    const idBox = contentEl.createDiv();
    idBox.setCssStyles({
      padding: '10px 12px',
      marginBottom: '16px',
      borderRadius: '8px',
      border: '1px solid var(--background-modifier-border)',
      fontSize: '12px',
      lineHeight: '1.5',
    });
    idBox.createEl('div', { text: 'Shared by user ID:' });
    const uidEl = idBox.createEl('code', { text: this.info.senderUid });
    uidEl.setCssStyles({ wordBreak: 'break-all' });

    const behavior = this.info.accessMode === 'read_only'
      ? 'It will be imported as a read-only mirror that receives updates from the owner.'
      : this.info.accessMode === 'public_edit'
        ? 'It will be imported as an editable note with two-way sync. Anyone with its web link can also edit.'
        : 'It will be imported as an editable note. Only invited collaborators can access it.';
    const behaviorDescription = desc.createEl('p', {
      text: `${behavior} Accept to add it to your vault, or deny to ignore it.`,
    });
    behaviorDescription.setCssStyles({ fontSize: '13px' });

    // Buttons
    const btnRow = contentEl.createDiv();
    btnRow.setCssStyles({ display: 'flex', gap: '8px', justifyContent: 'flex-end' });

    const denyBtn = btnRow.createEl('button', { text: 'Deny' });
    denyBtn.addEventListener('click', () => this.decide('deny'));

    const acceptBtn = btnRow.createEl('button', { text: 'Accept & import' });
    acceptBtn.setCssStyles({
      background: 'var(--interactive-accent)',
      color: 'var(--text-on-accent)',
    });
    acceptBtn.addEventListener('click', () => this.decide('accept'));
  }

  private decide(decision: ShareDecision) {
    this.decided = true;
    this.onDecision(decision);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
    // Dismissed without choosing — leave the share pending for next time.
    if (!this.decided) this.onDecision('later');
  }
}
