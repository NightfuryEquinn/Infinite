var threePromise = null;

// Returns a cached promise that resolves to the Three.js module
export function loadThree() {
  if (threePromise) return threePromise;

  threePromise = import('three').then(function (m) {
    return m;
  });
  return threePromise;
}
