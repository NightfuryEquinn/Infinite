import 'react'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'infinite-world': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >
    }
  }
}
