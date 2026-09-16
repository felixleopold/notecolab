import { Modal, type App, type TFile } from 'obsidian';
import { parseFrontmatter } from '../../session/sessions';
import { findImageEmbeds } from '../../share/imageEmbeds';
import ShareNoteComponent from '../components/ShareNote.svelte';
import type { Contact } from '../../types';

export interface ShareOptions {
  accessMode: 'public_edit' | 'invited_edit' | 'read_only';
  updateMode?: 'snapshot' | 'live';
  expiresIn: number;
  showHelp: boolean;
  collaborators: string[];
  /** Reader presentation for read-only links (encoded into the share URL). */
  theme: 'auto' | 'light' | 'dark';
  showHeader: boolean;
  showControls: boolean;
  showChrome: boolean;
}

export interface ShareSubmitResult {
  ok: boolean;
  error?: string;
}

export class ShareModalView extends Modal {
  private component: InstanceType<typeof ShareNoteComponent> | null = null;
  private defaults: ShareOptions;
  private contacts: Contact[];
  private onSubmit: (result: ShareOptions) => Promise<ShareSubmitResult>;
  private submitting = false;

  constructor(app: App, defaults: ShareOptions, contacts: Contact[], onSubmit: (result: ShareOptions) => Promise<ShareSubmitResult>, private simple = false, private file?: TFile) {
    super(app);
    this.defaults = defaults;
    this.contacts = contacts;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    contentEl.empty();
    contentEl.addClass('notecolab-share-modal');

    modalEl.setCssStyles({ width: '620px', maxWidth: '90vw' });

    this.component = new ShareNoteComponent({
      target: contentEl,
      props: {
        accessMode: this.defaults.accessMode,
        updateMode: this.defaults.updateMode || 'live',
        expiresIn: this.defaults.expiresIn,
        showHelp: this.defaults.showHelp,
        theme: this.defaults.theme,
        showHeader: this.defaults.showHeader,
        showControls: this.defaults.showControls,
        showChrome: this.defaults.showChrome,
        contacts: this.contacts,
        collaborators: [...(this.defaults.collaborators || [])],
        submitting: false,
        submitError: '',
        simple: this.simple,
      },
    });

    if (this.file) {
      const preview = contentEl.createEl('details');
      preview.createEl('summary', { text: 'Review the Markdown and images being shared' });
      preview.createEl('p', { text: 'Properties are excluded. The Markdown source, including comments and embedded image references, is shared. Review it before continuing.' });
      const source = preview.createEl('pre');
      source.setCssStyles({ maxHeight: '240px', overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: '12px' });
      void this.app.vault.read(this.file).then((content) => {
        const { body } = parseFrontmatter(content);
        source.textContent = body;
        const images = findImageEmbeds(body);
        preview.createEl('p', { text: images.length ? `Embedded images: ${images.join(', ')}` : 'No embedded images.' });
      }).catch(() => { source.textContent = 'Preview unavailable. Close this dialog and reopen the note before sharing.'; });
    }

    this.component.$on('share', (e: CustomEvent<ShareOptions>) => { void (async () => {
      if (this.submitting) return;
      this.submitting = true;
      this.component?.$set({ submitting: true, submitError: '' });
      try {
        const result = await this.onSubmit(e.detail);
        if (result.ok) {
          this.component?.$set({ submitError: '' });
          this.close();
          return;
        }
        this.component?.$set({
          submitting: false,
          submitError: result.error || 'The share could not be created. Check your connection and try again.',
        });
      } catch (error) {
        console.error('NoteColab: share submission failed', error);
        this.component?.$set({
          submitting: false,
          submitError: 'The share could not be created. Check your connection and try again.',
        });
      } finally {
        this.submitting = false;
      }
    })(); });
  }

  onClose(): void {
    this.component?.$destroy();
    this.component = null;
  }
}
