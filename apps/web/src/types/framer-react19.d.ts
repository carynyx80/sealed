/**
 * Compatibility shim: framer-motion 11.11.x type definitions reference React 18 type names
 * (`ReactHTML`, `DetailedHTMLFactory`, global `JSX`) that @types/react 19 removed. Without this,
 * every `motion.*` element rejects standard props like `className`. Types only — no runtime effect.
 */
import type * as React from "react";

type HtmlTag = keyof HTMLElementTagNameMap & keyof React.JSX.IntrinsicElements;

type ReactHTMLMap = {
  [K in HtmlTag]: React.DetailedHTMLFactory<React.JSX.IntrinsicElements[K] & React.HTMLAttributes<HTMLElementTagNameMap[K]>, HTMLElementTagNameMap[K]>;
};

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface DetailedHTMLFactory<P extends HTMLAttributes<T>, T extends HTMLElement> {
    (props?: (ClassAttributes<T> & P) | null, ...children: ReactNode[]): DetailedReactHTMLElement<P, T>;
  }
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ReactHTML extends ReactHTMLMap {}
}

declare global {
  namespace JSX {
    type Element = React.JSX.Element;
    type ElementClass = React.JSX.ElementClass;
    type ElementAttributesProperty = React.JSX.ElementAttributesProperty;
    type ElementChildrenAttribute = React.JSX.ElementChildrenAttribute;
    type LibraryManagedAttributes<C, P> = React.JSX.LibraryManagedAttributes<C, P>;
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface IntrinsicAttributes extends React.JSX.IntrinsicAttributes {}
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface IntrinsicClassAttributes<T> extends React.JSX.IntrinsicClassAttributes<T> {}
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface IntrinsicElements extends React.JSX.IntrinsicElements {}
  }
}

export {};
