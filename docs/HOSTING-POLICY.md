# Hosted service and data lifecycle

This policy describes the intended terms for new hosted plans. It is not a
promise of perpetual hosting, an uptime guarantee, or authorization to delete
existing users' data. Existing paid commitments remain in force. Before applying
these new terms at checkout, display the applicable version to the customer and
record acceptance.

## Operator and contact

The hosted service at notecolab.com is operated by [Felix Mrak](https://felixmrak.com).
Support, privacy, and hosting questions: [contact@felixmrak.com](mailto:contact@felixmrak.com).

## What a plan pays for

A plan buys the published collaborator capacity and storage allowance for the
stated paid period. Features, price, billing interval, and renewal behavior must
be shown before purchase. A payment does not buy permanent storage. Collaborators
do not need their own paid plan to join a share covered by its owner's allowance.
Self-hosted operators set their own limits and policies.

## Expiry and cancellation

Cancellation stops future renewals; the paid allowance continues through the
already-paid period. On expiry, an account within the free allowance can remain
on the free plan. If over that allowance, existing content stays readable and
exportable for at least 30 days. Further storage growth or new collaborator
grants can be restricted. Losing a paid plan must not silently delete notes or
evict collaborators while they are editing.

Before any quota-related removal, show a dated notice in the account and plugin,
and email users who supplied a notification address. Allow at least 30 days from
that notice to export, reduce usage, or renew. The deletion deadline must be
visible even when the user cannot add content. Anonymous users need an in-app
notice because an email address may not exist.

## If we stop hosting NoteColab

We may stop offering new subscriptions or renewals and retire the hosted service.
Announce retirement at least 60 days before normal service ends. Existing paid
periods will be served through their paid-through date; do not sell renewals that
extend beyond a known retirement date.

For each account, keep read and export access for at least 30 days after the later
of its paid-through date and the announced service-end date. Display the exact
deadline and provide export instructions in the web app, plugin, and public
status page. After that deadline, hosted notes, attachments, share links, and
account data may be removed. An emergency that prevents fulfilling a paid period
requires a separate remedy, including any refund required by applicable law.
Nothing in this policy limits mandatory consumer rights.

## Local copies, deletion, and backups

Retiring the service does not delete independent Markdown files or downloaded
attachments in users' vaults. Online share links and live collaboration stop
working. Export while access is available and verify the exported files and
images before the deadline. A browser link is not a backup.

After a notified deletion, remaining backup copies should age out within 30 days,
apart from records that must be retained by law. Restored backups must reapply
recorded deletions before serving traffic. Financial records may have different
legal retention periods and must be kept separate from note content.

## Operator release gate

Do not apply these new terms at checkout or enable automated retention cleanup until:

- the operator's identity, contact details, prices, and renewal terms are complete;
- the deployed policy has received jurisdiction-appropriate legal review;
- policy acceptance, dated notices, account deadlines, and export work end to end;
- existing entitlements and any earlier promises are accounted for;
- backup retirement and deletion replay have been verified.

The current implementation does not run automatic quota-expiry or service-sunset
deletion. These gates avoid advertising a lifecycle that the service cannot yet
carry out safely. Explicit owner revocation and existing link expiry are separate.
