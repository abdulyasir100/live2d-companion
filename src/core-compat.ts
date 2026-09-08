/**
 * Reconciles a version skew between the Cubism Core and the framework.
 *
 * The Core published on the CDN takes `csmGetMocVersion(moc, buffer)`, but
 * CubismWebFramework 5-r.5 calls it as `csmGetMocVersion(buffer)`. The one-arg
 * call leaves the buffer undefined inside Core and throws while reading
 * `.byteLength`, which fails every model load.
 *
 * Patching here rather than in vendor/ keeps the framework checkout pristine,
 * so it can be re-cloned or updated without carrying local edits.
 */
export function installCoreCompat(log: (msg: string) => void = () => {}): void {
  const version = Live2DCubismCore.Version as any;
  const original = version.csmGetMocVersion;

  if (typeof original !== 'function' || original.length < 2) {
    return; // Core already matches what the framework expects
  }

  version.csmGetMocVersion = (a: any, b?: any) => {
    if (b !== undefined) return original.call(version, a, b);
    // Called the old way with just a buffer: build the Moc the Core now wants.
    const moc = Live2DCubismCore.Moc.fromArrayBuffer(a);
    return original.call(version, moc, a);
  };

  log(`patched csmGetMocVersion (Core arity ${original.length}, framework expects 1)`);
}
