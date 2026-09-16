import type { RouterConfig } from '@nuxt/schema'
import { hashScrollTargetId } from './utils/hashScroll'

export default <RouterConfig>{
  scrollBehavior(to, _from, savedPosition) {
    if (savedPosition) return savedPosition

    const targetId = hashScrollTargetId(to.path, to.hash)
    if (targetId && typeof document !== 'undefined') {
      const target = document.getElementById(targetId)
      if (target) return { el: target }
    }

    if (to.hash) return false
    return { left: 0, top: 0 }
  },
}
