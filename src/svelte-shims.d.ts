declare module "*.svelte" {
	import type { SvelteComponent } from 'svelte';

	const component: typeof SvelteComponent<
		Record<string, unknown>,
		Record<string, CustomEvent<never>>,
		Record<string, never>
	>;
	export default component;
}
