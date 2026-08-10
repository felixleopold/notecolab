import { Modal, Setting, type App } from 'obsidian';

export class ImportModal extends Modal {
  private url = '';
  private onSubmit: (url: string) => void;

  constructor(app: App, onSubmit: (url: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Import Shared Note' });

    new Setting(contentEl)
      .setName('Share link')
      .setDesc('Paste the share link you received')
      .addText((text) => {
        text
          .setPlaceholder('https://notecolab.com/s/...')
          .onChange((value) => {
            this.url = value;
          });
        text.inputEl.style.width = '100%';
      });

    new Setting(contentEl)
      .addButton((btn) => {
        btn
          .setButtonText('Import')
          .setCta()
          .onClick(() => {
            if (this.url) {
              this.close();
              this.onSubmit(this.url);
            }
          });
      });
  }

  onClose() {
    this.contentEl.empty();
  }
}
