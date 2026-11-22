/* Sun and moon times worked out on the phone (works offline). Formulas after SunCalc (V. Agafonkin, BSD licence). */
(() => {
  const PI = Math.PI, rad = PI / 180, dayMs = 864e5, J1970 = 2440588, J2000 = 2451545, e = rad * 23.4397;
  const toDays = d => d / dayMs - .5 + J1970 - J2000;
  const fromJulian = j => new Date((j + .5 - J1970) * dayMs);
  const ra = (l, b) => Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
  const decl = (l, b) => Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
  const alt = (H, phi, dec) => Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const sidereal = (d, lw) => rad * (280.16 + 360.9856235 * d) - lw;
  const M_ = d => rad * (357.5291 + .98560028 * d);
  const eclLon = M => M + rad * (1.9148 * Math.sin(M) + .02 * Math.sin(2 * M) + .0003 * Math.sin(3 * M)) + rad * 102.9372 + PI;
  const sunCoords = d => { const L = eclLon(M_(d)); return {dec: decl(L, 0), ra: ra(L, 0)}; };
  const J0 = .0009;
  function sunTimes(date, lat, lng) {
    const lw = rad * -lng, phi = rad * lat, d = toDays(date), n = Math.round(d - J0 - lw / (2 * PI));
    const ds = J0 + lw / (2 * PI) + n, M = M_(ds), L = eclLon(M), dec = decl(L, 0);
    const Jnoon = J2000 + ds + .0053 * Math.sin(M) - .0069 * Math.sin(2 * L);
    const setJ = h => { const w = Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
      const a = J0 + (w + lw) / (2 * PI) + n; return J2000 + a + .0053 * Math.sin(M) - .0069 * Math.sin(2 * L); };
    const r = {};
    for (const [ang, rise, set] of [[-.833, 'sunrise', 'sunset'], [-6, 'dawn', 'dusk']]) { const Js = setJ(ang * rad); r[set] = fromJulian(Js); r[rise] = fromJulian(Jnoon - (Js - Jnoon)); }
    return r;
  }
  function moonCoords(d) {
    const L = rad * (218.316 + 13.176396 * d), M = rad * (134.963 + 13.064993 * d), F = rad * (93.272 + 13.229350 * d);
    const l = L + rad * 6.289 * Math.sin(M), b = rad * 5.128 * Math.sin(F);
    return {ra: ra(l, b), dec: decl(l, b), dist: 385001 - 20905 * Math.cos(M)};
  }
  function moonAlt(date, lat, lng) { const d = toDays(date), c = moonCoords(d); return alt(sidereal(d, rad * -lng) - c.ra, rad * lat, c.dec); }
  function moonIllum(date) {
    const d = toDays(date), s = sunCoords(d), m = moonCoords(d), sd = 149598000;
    const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
    const inc = Math.atan2(sd * Math.sin(phi), m.dist - sd * Math.cos(phi));
    const ang = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra), Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
    return {fraction: (1 + Math.cos(inc)) / 2, phase: .5 + .5 * inc * (ang < 0 ? -1 : 1) / PI};
  }
  // Moon over a local day: rise, set, overhead (highest) and underfoot (lowest), sampled every 5 minutes.
  function moonDay(dayStart, lat, lng) {
    let prev = null, out = {}, hi = -9, lo = 9;
    for (let m = 0; m <= 1440; m += 5) {
      const t = new Date(dayStart.getTime() + m * 6e4), h = moonAlt(t, lat, lng);
      if (h > hi) { hi = h; out.overhead = t; } if (h < lo) { lo = h; out.underfoot = t; }
      if (prev != null) { if (prev < 0 && h >= 0 && !out.rise) out.rise = t; if (prev >= 0 && h < 0 && !out.set) out.set = t; }
      prev = h;
    }
    return out;
  }
  function phaseName(p) {
    return p < .03 || p > .97 ? 'New moon' : p < .22 ? 'Waxing crescent' : p < .28 ? 'First quarter' : p < .47 ? 'Waxing gibbous'
      : p < .53 ? 'Full moon' : p < .72 ? 'Waning gibbous' : p < .78 ? 'Last quarter' : 'Waning crescent';
  }
  window.Sky = {sunTimes, moonDay, moonIllum, phaseName};
})();
