import { useEffect } from 'react'
import '../engine/engine.js'

export function InfiniteWorld() {
  useEffect(() => {
    document.title = 'Infinite Explorer'
  }, [])

  return (
    <infinite-world
      style={{
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100%',
      }}
    />
  )
}
