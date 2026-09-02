/* utm11.mjs — WGS84/NAD83 lon-lat <-> UTM zone 11N (EPSG:26911), Snyder series.
 *
 * Every binary in this project is georeferenced in UTM 11N metres; the building
 * footprints arrive in lon/lat, so one of the two has to move. Doing it here,
 * offline, keeps the scene free of any projection code.
 *
 * GRS80 (NAD83) ellipsoid. The NAD83-vs-WGS84 datum shift in this part of
 * California is ~1 m horizontally — below the accuracy of an ML-traced
 * footprint, so no datum transformation is applied.
 */
const a  = 6378137.0;
const f  = 1 / 298.257222101;
const e2 = f * (2 - f);
const ep2 = e2 / (1 - e2);
const k0 = 0.9996;
const FE = 500000;
const LON0 = -117 * Math.PI / 180;   // zone 11 central meridian
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

const M0coef = [
  1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256,
  3 * e2 / 8 + 3 * e2 * e2 / 32 + 45 * e2 ** 3 / 1024,
  15 * e2 * e2 / 256 + 45 * e2 ** 3 / 1024,
  35 * e2 ** 3 / 3072,
];
function meridArc(phi) {
  return a * (M0coef[0] * phi - M0coef[1] * Math.sin(2 * phi)
            + M0coef[2] * Math.sin(4 * phi) - M0coef[3] * Math.sin(6 * phi));
}

export function toUTM(lon, lat) {
  const phi = lat * D2R, lam = lon * D2R;
  const sp = Math.sin(phi), cp = Math.cos(phi), tp = Math.tan(phi);
  const N = a / Math.sqrt(1 - e2 * sp * sp);
  const T = tp * tp, C = ep2 * cp * cp, A = (lam - LON0) * cp;
  const M = meridArc(phi);
  const E = FE + k0 * N * (A + (1 - T + C) * A ** 3 / 6
          + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120);
  const Nn = k0 * (M + N * tp * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24
          + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
  return [E, Nn];
}

export function toLonLat(E, N) {
  const x = E - FE, y = N / k0;
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const mu = y / (a * M0coef[0]);
  const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
             + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
             + (151 * e1 ** 3 / 96) * Math.sin(6 * mu)
             + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const s1 = Math.sin(phi1), c1 = Math.cos(phi1), t1 = Math.tan(phi1);
  const C1 = ep2 * c1 * c1, T1 = t1 * t1;
  const N1 = a / Math.sqrt(1 - e2 * s1 * s1);
  const R1 = a * (1 - e2) / (1 - e2 * s1 * s1) ** 1.5;
  const D = x / (N1 * k0);
  const phi = phi1 - (N1 * t1 / R1) * (D * D / 2
            - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24
            + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
  const lam = LON0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6
            + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / c1;
  return [lam * R2D, phi * R2D];
}
