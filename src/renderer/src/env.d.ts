/// <reference types="vite/client" />

import type { JSX as ReactJSX } from 'react'
import type { LumenApi } from '@shared/channels'
import type { LegacyApi } from '@shared/legacy-api'

declare global {
  interface Window {
    lumen: LumenApi
    /** @deprecated use window.lumen */
    api: LegacyApi
  }

  namespace JSX {
    type Element = ReactJSX.Element
    type ElementClass = ReactJSX.ElementClass
    type ElementAttributesProperty = ReactJSX.ElementAttributesProperty
    type ElementChildrenAttribute = ReactJSX.ElementChildrenAttribute
    type LibraryManagedAttributes<C, P> = ReactJSX.LibraryManagedAttributes<C, P>
    type IntrinsicAttributes = ReactJSX.IntrinsicAttributes
    type IntrinsicClassAttributes<T> = ReactJSX.IntrinsicClassAttributes<T>
    type IntrinsicElements = ReactJSX.IntrinsicElements
  }
}
