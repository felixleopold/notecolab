<template>
  <div class="marketing-scroll">
    <section class="marketing-page-hero"><div class="marketing-container marketing-narrow"><p class="marketing-kicker">Hosting policy · draft</p><h1>Paid time, clear limits, time to leave.</h1><p class="marketing-lede">Our proposed policy for new hosted plans. Existing paid agreements remain in force until new terms are explicitly adopted.</p></div></section>
    <div class="marketing-container marketing-narrow marketing-page-content">
      <section class="prose-section"><h2>Who runs the hosted service</h2><p>Note Colab at notecolab.com is operated by <a href="https://felixmrak.com">Felix Mrak</a>. For support or hosting questions, email <a href="mailto:contact@felixmrak.com">contact@felixmrak.com</a>. These proposed terms concern the hosted service; self-hosted operators set their own terms.</p></section>
      <section class="prose-section"><h2>Your paid period</h2><p>A plan pays for the stated storage and collaborator allowance for a stated period. Cancellation stops renewal; it does not shorten time already paid for. Hosting is not a lifetime purchase.</p></section>
      <section class="prose-section"><h2>If your plan expires</h2><p>Accounts within the free allowance can continue on the free plan. Above that allowance, we may restrict new storage or collaborators. Existing data remains readable and exportable for at least 30 days. Any quota-related removal requires a dated notice and at least 30 days to export, reduce usage, or renew.</p></section>
      <section class="prose-section"><h2>If we retire the service</h2><p>We will announce retirement at least 60 days before normal service ends and honor existing paid-through dates. Each account gets at least 30 days of read and export access after the later of its paid-through date and the announced service-end date. After the stated deadline, hosted content and accounts may be removed.</p><p>Your independent local Markdown files remain yours. Hosted links and live collaboration stop working. Download attachments and check your exports before the deadline.</p></section>
      <section class="prose-section"><h2>Before these terms take effect</h2><p>Operator details, payment terms, policy acceptance, dated notices, exports, and backup deletion must be ready and reviewed. Automatic quota-expiry and service-retirement deletion are not currently enabled. Mandatory consumer rights remain unaffected.</p><p>Read the <a href="https://github.com/felixleopold/notecolab/blob/main/docs/HOSTING-POLICY.md">full proposed hosting policy and release requirements</a>. Self-hosted operators set their own terms.</p></section>
    </div>
    <MarketingFooter />
  </div>
</template>
<script setup lang="ts">
useHead({ title: 'Hosting policy | Note Colab', meta: [{ name: 'description', content: 'Proposed Note Colab hosting policy: paid periods, cancellation, notice, and export access.' }] })
</script>
