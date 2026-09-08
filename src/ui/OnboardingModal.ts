import { Modal, type App } from 'obsidian';

const FEEDBACK_URL = 'https://github.com/felixleopold/notecolab/issues';
const ONBOARDING_STEPS = 4;

interface OnboardingOptions {
  serverUrl: string;
  onShare: () => void;
  onDone: () => Promise<void>;
}

export class OnboardingModal extends Modal {
  private step = 1;
  private handingOffToShare = false;

  constructor(app: App, private options: OnboardingOptions) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.setCssStyles({ width: '540px', maxWidth: '90vw' });
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.handingOffToShare) void this.options.onDone();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.setCssStyles({ padding: '8px 8px 4px' });

    contentEl.createEl('div', {
      text: `Step ${this.step} of ${ONBOARDING_STEPS}`,
      cls: 'setting-item-description',
    }).setCssStyles({ marginBottom: '8px', fontWeight: '600' });

    if (this.step === 1) this.renderWelcome();
    if (this.step === 2) this.renderInstructions();
    if (this.step === 3) this.renderFeedback();
    if (this.step === 4) this.renderFirstShare();

    const footer = contentEl.createDiv();
    footer.setCssStyles({
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      marginTop: '24px',
    });

    const skip = footer.createEl('button', { text: 'Skip onboarding' });
    skip.addEventListener('click', () => this.close());

    const controls = footer.createDiv();
    controls.setCssStyles({ display: 'flex', gap: '8px' });
    if (this.step > 1) {
      const back = controls.createEl('button', { text: 'Back' });
      back.addEventListener('click', () => {
        this.step -= 1;
        this.render();
      });
    }

    if (this.step < ONBOARDING_STEPS) {
      const next = controls.createEl('button', { text: 'Continue', cls: 'mod-cta' });
      next.addEventListener('click', () => {
        this.step += 1;
        this.render();
      });
    } else {
      const file = this.app.workspace.getActiveFile();
      if (file) {
        const share = controls.createEl('button', {
          text: `Share ${file.basename}`,
          cls: 'mod-cta',
        });
        share.addEventListener('click', () => {
          this.handingOffToShare = true;
          this.close();
          this.options.onShare();
        });
      } else {
        const finish = controls.createEl('button', { text: 'Finish', cls: 'mod-cta' });
        finish.addEventListener('click', () => this.close());
      }
    }
  }

  private renderWelcome(): void {
    this.contentEl.createEl('h2', { text: "You're ready to share" });
    this.contentEl.createEl('p', {
      text: `Note Colab connected to ${this.options.serverUrl} automatically. No email address or password is required.`,
    });

    const status = this.contentEl.createDiv();
    status.setCssStyles({
      marginTop: '18px',
      padding: '12px 14px',
      border: '1px solid var(--background-modifier-border)',
      borderRadius: '8px',
      background: 'var(--background-secondary)',
    });
    status.createEl('strong', { text: '✓ Connected and ready' });
  }

  private renderInstructions(): void {
    this.contentEl.createEl('h2', { text: 'How to share any note' });
    this.contentEl.createEl('p', {
      text: 'You can always start sharing from the command palette, regardless of your workspace layout.',
    });

    const list = this.contentEl.createEl('ol');
    list.setCssStyles({ margin: '18px 0 0', paddingLeft: '24px' });
    list.createEl('li', { text: 'Open the note you want to share.' });
    const palette = list.createEl('li');
    palette.appendText('Open the command palette with ');
    palette.createEl('kbd', { text: 'Ctrl/Cmd + P' });
    palette.appendText('.');
    const command = list.createEl('li');
    command.appendText('Search for ');
    command.createEl('strong', { text: 'Note Colab: Share note' });
    command.appendText(' and press Enter.');
    for (const item of Array.from(list.children)) {
      (item as HTMLElement).setCssStyles({ marginBottom: '10px', paddingLeft: '4px' });
    }
  }

  private renderFeedback(): void {
    this.contentEl.createEl('h2', { text: 'Help shape Note Colab' });
    this.contentEl.createEl('p', {
      text: 'Your feedback helps me decide what to improve next. Please tell me which features you would like to see and what, if anything, is holding you back from using Note Colab.',
    });

    const feedback = this.contentEl.createEl('button', {
      text: 'Leave feedback on GitHub',
      cls: 'mod-cta',
    });
    feedback.setCssStyles({ marginTop: '10px' });
    feedback.addEventListener('click', () => window.open(FEEDBACK_URL, '_blank', 'noopener,noreferrer'));
  }

  private renderFirstShare(): void {
    const file = this.app.workspace.getActiveFile();
    this.contentEl.createEl('h2', { text: 'Share your first note' });
    if (!file) {
      this.contentEl.createEl('p', {
        text: 'No note is open right now. Finish this guide, open a note, then use the command palette steps you just learned.',
      });
      return;
    }

    this.contentEl.createEl('p', {
      text: 'Choose who can use the note. Note Colab will create the link and copy it for you.',
    });
    const note = this.contentEl.createDiv();
    note.setCssStyles({
      marginTop: '18px',
      padding: '12px 14px',
      border: '1px solid var(--background-modifier-border)',
      borderRadius: '8px',
      background: 'var(--background-secondary)',
    });
    note.createEl('span', { text: 'Active note', cls: 'setting-item-description' });
    note.createEl('strong', { text: file.path }).setCssStyles({ display: 'block', marginTop: '3px' });
  }
}
