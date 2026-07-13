var threePromise = null;

export function loadThree() {
  if (threePromise) return threePromise;
  threePromise = import('three').then(function (m) {
    return m;
  });
  return threePromise;
}
