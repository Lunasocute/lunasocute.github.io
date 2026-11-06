/* chrome.js — the fixed WebGL2 backdrop behind the page.
 *
 * A full-screen shader that moves through four scenes as the page scrolls:
 *   the crescent and the name → stars → water caustics → small hanging chains.
 *
 * The hero is one raymarched 3D scene. The crescent is a signed distance field: a round-sectioned
 * arc, fullest at its middle and tapering evenly to two tips, mirrored top to bottom. Thorns grade
 * from large at the middle to small at the tips, and tunnels pierce the body.
 *
 * The name lives in the same field. Its letters are a 2D distance field, baked once from a canvas,
 * given a domed depth, so they have real thickness, reflect in the crescent, turn with it, and melt
 * into the inner thorns that reach them.
 *
 * Rays are clipped to the slab the scene occupies, and edges are antialiased from how closely a
 * ray passes the surface. Exposes window.LunaGL; script.js drives it from its single rAF loop.
 */
(() => {
  'use strict';

  const canvas = document.getElementById('gl');
  const gl = canvas && canvas.getContext('webgl2', {
    antialias: false, alpha: false, depth: false, powerPreference: 'high-performance'
  });
  if (!gl) { document.documentElement.classList.add('no-gl'); return; }

  const small = matchMedia('(max-width: 760px)').matches || (navigator.hardwareConcurrency || 8) <= 4;
  const DEG = Math.PI / 180;

  /* ---------- the crescent's proportions ---------- */

  // t runs along one half of the mirrored arc: 0 at the tip, 1 at the fullest middle.
  const TIP = 32 * DEG, BODY = .215, TAPER = 1.2;
  const arcAngle = t => TIP + (Math.PI - TIP) * t;
  const arcRadius = t => 1 + .03 * (1 - t) * (1 - t);
  const arcCentre = t => { const a = arcAngle(t), R = arcRadius(t); return [R * Math.cos(a), R * Math.sin(a)]; };
  const bodyRadius = t => BODY * Math.pow(Math.sin(t * Math.PI / 2), TAPER);

  // Thorns on the upper half (the mirror makes the rest): short and broad-based, so each one rises
  // out of the body like a swelling of the metal instead of a spike stuck onto it. They grow a
  // little toward the middle and lean toward the nearest tip, so the outline flows one way.
  const thorns = [];
  const addThorn = (t, outward, len, radius, sweep, z) => {
    const a = arcAngle(t), [cx, cy] = arcCentre(t), r = bodyRadius(t) * .72 * (outward ? 1 : -1);
    const dir = (outward ? a : a + Math.PI) - sweep * (outward ? 1 : -1);
    thorns.push({
      base: [cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0],
      radius,
      tip: [Math.cos(dir) * len, Math.sin(dir) * len, z],
      bend: outward ? .3 : -.22
    });
  };
  const OUTER = [.3, .54, .77, .95];
  OUTER.forEach(t => addThorn(t, true, .13 + .08 * t, .05 + .045 * t, .12 + .5 * (1 - t), 0));
  // Smaller ones along the inside, sitting between the outer ones.
  [.42, .66, .87].forEach(t => addThorn(t, false, .09 + .07 * t, .045 + .025 * t, .1 + .4 * (1 - t), 0));
  const N = thorns.length;
  const thornA = new Float32Array(N * 4), thornB = new Float32Array(N * 4);
  thorns.forEach((t, i) => {
    thornA.set([...t.base, t.radius], i * 4);
    thornB.set([...t.tip, t.bend], i * 4);
  });

  // Where the name sits in the scene: starting in the crescent's hollow, running out through its opening.
  // The texture has margin all round so the letters' thorns have room.
  const NAME_FILL = .8, NAME_W = 1600, NAME_H = 800;
  const NAME_LEFT = -.3, NAME_RIGHT = 1.2;
  const nameBox = [
    (NAME_LEFT + NAME_RIGHT) / 2, -.005,
    (NAME_RIGHT - NAME_LEFT) / 2 / NAME_FILL,
    (NAME_RIGHT - NAME_LEFT) / 2 / NAME_FILL * NAME_H / NAME_W
  ];

  const VS = `#version 300 es
  precision highp float;
  out vec2 vUv;
  void main(){
    vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2);
    vUv = p;
    gl_Position = vec4(p*2.-1., 0., 1.);
  }`;

  // The studio the metal reflects. A broad overhead gradient and a pale floor let the curve of the
  // surface read as volume; the strips add the crisp streaks of polished chrome.
  const STUDIO = `vec3 studio(vec3 r){
    float y = r.y;
    float a = atan(r.x, r.z);
    vec3 c = mix(vec3(.02,.022,.03), vec3(.2,.215,.25), smoothstep(.0,.55,y));
    c = mix(c, vec3(1.75,1.78,1.85), smoothstep(.5,.6,y)*smoothstep(1.,.86,y));
    c += vec3(.44,.47,.54)*smoothstep(-.06,-.85,y);
    float s1 = abs(a - 1.85 + .3*y), s2 = abs(a + 1.15 - .35*y);
    c += vec3(1.25,1.28,1.38)*smoothstep(.12,.06,s1)*smoothstep(-.7,-.25,y)*smoothstep(.75,.35,y);
    c += vec3(.8,.84,1.)*smoothstep(.17,.09,s2)*smoothstep(-.6,-.1,y)*smoothstep(.6,.2,y);
    c += vec3(.75,.8,.95)*smoothstep(-.6,-.96,r.z);
    return c;
  }`;

  // Chains lying along the screen's edges and across its corners, drawn as a second pass over the
  // outer bands so they never slow the hero. Each path is a slack curve around a straight guide line.
  const SIDE_COUNT = 8;
  const SIDE_FS = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 o;
  uniform vec2 uRes, uPointer;
  uniform float uTime, uSlide;
  // Per chain: scale, inset, reveal, hidden distance / wander, frequency, phase, phase / guide point, inward normal
  uniform vec4 uSide[${SIDE_COUNT * 3}];

  ${STUDIO}

  const float LA = .0062, LR = .0105, LW = .0031, PITCH = 2.*(LA + LR - LW);
  float linkD(vec3 q){
    vec2 a = vec2(q.x, max(abs(q.y) - LA, 0.));
    return length(vec2(length(a) - LR, q.z)) - LW;
  }
  float chainD(vec3 q){
    float k0 = floor(q.y/(2.*PITCH) + .5);
    float k1 = floor((q.y - PITCH)/(2.*PITCH) + .5);
    vec3 a = vec3(q.x, q.y - k0*2.*PITCH, q.z);
    vec3 b = vec3(q.z, q.y - (k1*2. + 1.)*PITCH, -q.x);
    return min(linkD(a), linkD(b));
  }

  void main(){
    float asp = uRes.x/uRes.y;
    vec2 p = vec2((vUv.x-.5)*asp, vUv.y-.5);
    float pix = 1./uRes.y;
    vec4 acc = vec4(0.);

    for (int i=0; i<${SIDE_COUNT}; i++) {
      vec4 A = uSide[i*3], B = uSide[i*3 + 1], G = uSide[i*3 + 2];
      float sc = A.x, inset = A.y, reveal = A.z, hide = A.w;
      if (reveal <= .001) continue;
      float a1 = B.x, w1 = B.y, f1 = B.z, f2 = B.w, a2 = a1*.24, w2 = w1*1.63;
      float drift = .006*sin(uTime*.31 + f1);
      float base = inset - hide + drift;
      float slide = uSlide*(.6 + .4*sc);

      // The guide line's frame: "out" is distance inward from it, "run" is along it, always heading upward.
      vec2 inward = G.zw, dirn = vec2(-inward.y, inward.x);
      if (dirn.y < 0.) dirn = -dirn;
      vec2 dp = p - G.xy;
      float outv = dot(dp, inward), run = dot(dp, dirn) - slide;

      // Nearest point on the curve, by one Newton step from this pixel's position along the line.
      float t1 = w1*run + f1, t2 = w2*run + f2;
      float gx = base + a1*sin(t1) + a2*sin(t2);
      float dg = a1*w1*cos(t1) + a2*w2*cos(t2);
      float run0 = run + (outv - gx)*dg/(1. + dg*dg);
      t1 = w1*run0 + f1; t2 = w2*run0 + f2;
      gx = base + a1*sin(t1) + a2*sin(t2);
      dg = a1*w1*cos(t1) + a2*w2*cos(t2);
      float L = sqrt(1. + dg*dg);
      vec2 localN = vec2(1., -dg)/L, localT = vec2(-dg, -1.)/L;
      float across = dot(vec2(outv - gx, run - run0), localN);
      if (abs(across) > .022*sc) continue;
      vec2 N = inward*localN.x + dirn*localN.y, T = inward*localT.x + dirn*localT.y;

      // Arc length of the wandering curve, so links keep an even spacing along it.
      float stretch = 1. + (a1*a1*w1*w1 + a2*a2*w2*w2)*.25;
      float along = -(run0*stretch + a1*a1*w1*sin(2.*t1)*.125 + a2*a2*w2*sin(2.*t2)*.125);
      vec2 rel = vec2(across, along)/sc;

      float turn = .78 + .1*sin(uTime*.3 + f1*2.);
      float ct = cos(turn), st = sin(turn);
      float z = .05, bestD = 1e9, zBest = z;
      for (int j=0; j<26; j++) {
        vec3 q = vec3(rel.x*ct - z*st, rel.y, rel.x*st + z*ct);
        float d = chainD(q);
        if (d < bestD) { bestD = d; zBest = z; }
        if (d < .00015 || z < -.05) break;
        z -= d*.9;
      }
      float cov = 1. - smoothstep(pix/sc*.1, pix/sc*1.15, bestD);
      if (cov <= 0.) continue;

      const vec2 k = vec2(1.,-1.);
      const float e = .0006;
      vec3 q0 = vec3(rel.x, rel.y, zBest);
      vec3 n = vec3(0.);
      for (int s=0; s<4; s++) {
        vec3 o4 = s == 0 ? k.xyy : s == 1 ? k.yyx : s == 2 ? k.yxy : k.xxx;
        vec3 w = q0 + o4*e;
        n += o4*chainD(vec3(w.x*ct - w.z*st, w.y, w.x*st + w.z*ct));
      }
      n = normalize(n);
      // Back from the chain's bent frame to the room.
      vec3 world = normalize(vec3(N*n.x + T*n.y, n.z));
      vec3 r = reflect(vec3(0.,0.,-1.), world);
      r.xy += uPointer*vec2(.14,-.1);
      vec3 col = studio(normalize(r));
      col *= .78 + .22*pow(1. - clamp(world.z,0.,1.), 4.);
      col *= .8 + .2*smoothstep(.68, 1., sc);   // the smaller chains sit further back
      col /= 1. + .14*col;
      acc = vec4(col*cov + acc.rgb*(1. - cov), cov + acc.a*(1. - cov));
    }
    o = acc;
  }`;

  // Compiled per scene: only the hero's program has its raymarcher and only the last section's has
  // the chains, since some drivers flatten branches and would otherwise pay for both everywhere.
  const FS = (hero, chains) => `#version 300 es
  #define HERO ${hero ? 1 : 0}
  #define CHAINS ${chains ? 1 : 0}
  precision highp float;
  in vec2 vUv; out vec4 o;
  uniform vec2 uRes, uPointer;
  uniform float uTime, uVeins, uGrow, uHero, uStars, uCaustic, uChains, uScroll;
  uniform vec4 uChain[4];     // x, length, sway phase, whether it ends in a charm
  uniform sampler2D uName;
  uniform vec4 uNameBox;
  uniform float uNameReady;
  uniform vec3 uObject;       // where the scene sits on screen: centre, scale
  uniform mat3 uRot;
  uniform vec4 uThornA[${N}], uThornB[${N}];

  float h21(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
  vec2  h22(vec2 p){ float n = h21(p); return vec2(n, h21(p+n+7.1)); }

  #if HERO || CHAINS
  ${STUDIO}
  #endif

  #if HERO
  /* ---------- the scene ---------- */

  const float PI = 3.14159265, A0 = ${TIP.toFixed(5)};
  const mat2 TILT = mat2(${Math.cos(-3 * DEG).toFixed(5)}, ${Math.sin(-3 * DEG).toFixed(5)}, ${(-Math.sin(-3 * DEG)).toFixed(5)}, ${Math.cos(-3 * DEG).toFixed(5)});

  float smin(float a, float b, float k){ float h = max(k-abs(a-b),0.)/k; return min(a,b) - h*h*k*.25; }
  float smax(float a, float b, float k){ return -smin(-a,-b,k); }

  float moon(vec3 p){
    // A slight tilt keeps the mirror symmetry from looking mechanical. Very slow flexing.
    vec3 m = vec3(TILT*p.xy, p.z);
    m.xy += .008*sin(m.yx*1.7 + uTime*.2);
    m.y = abs(m.y);

    float a = atan(m.y, m.x);
    float t = clamp((a - A0)/(PI - A0), 0., 1.);
    float aa = A0 + (PI - A0)*t;
    float s = 1. - t;
    vec2 centre = (1. + .03*s*s)*vec2(cos(aa), sin(aa));
    // Grows from the fullest middle out to the tips.
    float reveal = smoothstep(1.02 - uGrow*1.12, 1.14 - uGrow*1.12, t);
    float rad = ${BODY.toFixed(3)}*pow(sin(t*PI*.5), ${TAPER.toFixed(2)})*reveal;
    float d = length(vec3(m.xy - centre, m.z)) - rad;

    // Too far for any thorn to matter: skip them.
    if (d > .5) return d - .3;

    for (int i=0; i<${N}; i++) {
      vec4 A = uThornA[i], B = uThornB[i];
      float g = smoothstep(.9 - float(i < ${OUTER.length} ? i : i - ${OUTER.length})*.15, 1., uGrow*1.3);
      vec3 ba = B.xyz*g*(1. + .025*sin(uTime*.4 + float(i)*1.3));
      vec3 pa = m - A.xyz;
      float h = clamp(dot(pa,ba)/max(dot(ba,ba),1e-5), 0., 1.);
      vec3 axis = ba*h + vec3(-ba.y, ba.x, 0.)*B.w*h*(h-1.);
      float w = 1. - h;
      d = smin(d, length(pa - axis) - A.w*g*w*sqrt(w), .13);
    }
    return d;
  }

  float letters(vec3 p){
    vec2 q = (p.xy - uNameBox.xy)/uNameBox.zw;
    vec2 outside = max(abs(q) - 1., 0.)*uNameBox.zw;
    float box = length(outside);
    if (uNameReady < .5 || box > .3) return box + .25;
    vec2 uv = q*vec2(.5,-.5) + .5;
    // Letters condense on load and evaporate as the hero scrolls away.
    float erode = (1. - smoothstep(.2,.8,uGrow))*.06 + smoothstep(.1,.34,uHero)*.075;
    float sd = textureLod(uName, uv, 0.).r + erode;
    float depth = clamp(-sd/.05, 0., 1.);
    float dz = abs(p.z) - .085*sqrt(depth*(2.-depth));
    return max(sd, dz*.75) + box;
  }

  float map(vec3 p){ return smin(moon(p), letters(p), .03); }

  vec3 normalAt(vec3 p, float e){
    const vec2 k = vec2(1.,-1.);
    return normalize(k.xyy*map(p + k.xyy*e) + k.yyx*map(p + k.yyx*e) + k.yxy*map(p + k.yxy*e) + k.xxx*map(p + k.xxx*e));
  }

  // Polished chrome, as bands across a stroke: x is -1 at its inner edge and +1 at its outer edge,
  // a is the position along it. The bands wander and drift slowly, so they read as moving light.
  vec3 flowChrome(float x, float a){
    float t = uTime;
    // Whole-number frequencies only: a is an angle, and these must meet up where it wraps around.
    x += .09*sin(a*2. + t*.13) + .045*sin(a*7. - t*.2) + .016*sin(a*17. + t*.11);
    float line = (x + .58)/.05, glint = (x - .78)/.04;
    float v = .018;
    v += 1.02*smoothstep(.12,.26,x)*smoothstep(.56,.4,x);     // the white band
    v += .12*smoothstep(.5,.72,x);                            // grey outer shoulder
    v += .55*exp(-glint*glint);                               // a fine glint near the outer edge
    v += .09*smoothstep(-.1,.12,x)*smoothstep(.3,.12,x);      // the band's soft inner falloff
    v += .7*exp(-line*line);                                  // one thin bright line in the dark
    v += .38*smoothstep(-.84,-1.02,x);                        // bright inner rim
    v *= 1. + .16*sin(x*46. + sin(a*5.)*3.);                  // fine lines running along the length
    return v*vec3(.97,.98,1.03);
  }

  vec4 scene(vec2 sp, float pix){
    const float F = 4.6;
    vec3 ro = uRot*vec3(0.,0.,F);
    vec3 rd = uRot*normalize(vec3(sp, -F));
    // Clip the ray to the slab the scene lives in: most of the cost saving.
    const float SLAB = .62;
    float rdz = abs(rd.z) < 1e-4 ? 1e-4 : rd.z;
    float t0 = (-SLAB - ro.z)/rdz, t1 = (SLAB - ro.z)/rdz;
    float tn = max(min(t0,t1), .05), tf = min(max(t0,t1), F*2.2);
    if (tn >= tf) return vec4(0.);

    float t = tn, best = 1e9, tBest = tn;
    float cone = pix/F;
    for (int i=0; i<72; i++) {
      float d = map(ro + rd*t);
      float ratio = d/t;
      if (ratio < best) { best = ratio; tBest = t; }
      if (d < .0003*t || t > tf) break;
      t += d*.86;
    }
    float cov = 1. - smoothstep(cone*.15, cone*1.25, best);
    if (cov <= 0.) return vec4(0.);

    // Settle exactly onto the surface: mirror-like shading turns any small error into visible terraces.
    if (best < cone) for (int i=0; i<3; i++) tBest += map(ro + rd*tBest)*.9;

    vec3 p = ro + rd*tBest;
    vec3 n = normalAt(p, max(.002, tBest*pix*.5));
    float isName = 1. - smoothstep(-.004, .03, letters(p) - moon(p));

    // Light that flows along the form. Each surface point is placed across its stroke's section:
    // on the crescent, how far the normal leans from the viewer toward the outer or inner edge,
    // so the bands follow the arc from tip to tip, the way a long lit tube reflects.
    vec3 nW = n*uRot;
    vec2 radial = normalize(p.xy);
    float acrossMoon = atan(dot(nW, vec3(radial, 0.)*uRot), nW.z)/1.5708;
    vec3 flow = flowChrome(acrossMoon + dot(uPointer, radial)*.1, atan(p.y, p.x));
    vec3 flowName = flowChrome(dot(nW.xy, vec2(-.62,.78))*1.5 + .12, p.x*2.2 + p.y*1.3);
    vec3 col = mix(flow, flowName, isName);

    // A little of the room on top, so turning the sculpture still moves the light across it.
    vec3 r = reflect(rd, n);
    vec3 rW = r*uRot;
    rW.xy += uPointer*vec2(.14,-.1);
    col = mix(col, studio(normalize(rW)), .12);

    float nv = clamp(dot(n,-rd), 0., 1.);
    col *= .92 + .35*pow(1.-nv, 4.);

    col = col/(1. + .14*col);
    return vec4(col, cov);
  }
  #endif

  /* ---------- stars, caustics ---------- */

  float stars(vec2 p, float seed){
    vec2 id = floor(p), f = fract(p);
    float s = 0.;
    for (int y=-1; y<=1; y++) for (int x=-1; x<=1; x++) {
      vec2 n = vec2(x,y);
      vec2 c = id + n + seed;
      float h = h21(c);
      if (h < .55) continue;
      vec2 d = f - n - h22(c);
      float b = pow((h-.55)/.45, 3.);
      float tw = .55 + .45*sin(uTime*(.5+h*1.8) + h*60.);
      float r = length(d);
      float glow = .00035/(d.x*d.x*d.y*d.y*900. + .00035);
      s += b*tw*(smoothstep(.022,.0,r)*1.2 + glow*smoothstep(.2,.0,r)*.55) + .22*smoothstep(.01,.0,r);
    }
    return s;
  }

  float caustic(vec2 p){
    float t = uTime*.13, v = 0., a = 1.;
    mat2 m = mat2(.8,.6,-.6,.8);
    for (int i=0; i<4; i++) {
      p += .62*vec2(sin(p.y*1.5 + t*1.2 + float(i)), cos(p.x*1.4 - t + float(i)*1.9));
      float l = abs(sin(p.x*1.1 + p.y*.8));
      v += a*.0035/(l*l + .0035);
      p = m*p*1.6 + 3.1;
      a *= .7;
    }
    return v;
  }

  #if CHAINS
  /* ---------- small chains, in the crescent's metal ---------- */

  // One link: a stadium-shaped ring in the xy plane, its long axis along y.
  const float LA = .0062, LR = .0105, LW = .0031, PITCH = 2.*(LA + LR - LW);
  float linkD(vec3 q){
    vec2 a = vec2(q.x, max(abs(q.y) - LA, 0.));
    return length(vec2(length(a) - LR, q.z)) - LW;
  }

  // A chain hanging down from y = 0, with y increasing downward. Links alternate a quarter turn,
  // so only the nearest of each orientation can ever be closest.
  float chainD(vec3 q, float len, float charm){
    float n = max(floor(len/PITCH), 2.);
    float k0 = clamp(floor(q.y/(2.*PITCH) + .5), 0., floor(n*.5));
    float k1 = clamp(floor((q.y - PITCH)/(2.*PITCH) + .5), 0., floor((n - 1.)*.5));
    vec3 a = vec3(q.x, q.y - k0*2.*PITCH, q.z);
    vec3 b = vec3(q.z, q.y - (k1*2. + 1.)*PITCH, -q.x);
    float d = min(linkD(a), linkD(b));
    if (charm > .5) {
      // A small crescent, hung from the last link.
      vec3 c = q - vec3(0., n*PITCH + LA + LR + .027, 0.);
      float cres = max(length(c.xy) - .03, .0245 - length(c.xy - vec2(.0125,.006)));
      vec2 w = vec2(cres + .002, abs(c.z) - .004);
      d = min(d, min(max(w.x,w.y), 0.) + length(max(w, 0.)) - .002);
    }
    return d;
  }

  vec4 chains(vec2 p, float pix){
    for (int i=0; i<4; i++) {
      vec4 C = uChain[i];
      // Lowered into view as the section arrives, and swaying a little.
      float top = .53 + (1. - uChains)*(C.y + .12);
      vec2 rel = vec2(p.x - C.x, top - p.y);
      float sway = .016*sin(uTime*.5 + C.z) + uPointer.x*.012;
      rel = vec2(rel.x*cos(sway) - rel.y*sin(sway), rel.x*sin(sway) + rel.y*cos(sway));
      if (abs(rel.x) > .05 || rel.y < -.03 || rel.y > C.y + .1) continue;

      // Turned on its axis, so both orientations of link show at once.
      float turn = .78 + .1*sin(uTime*.3 + C.z*2.);
      float ct = cos(turn), st = sin(turn);

      // A straight ray toward the chain: at this size, perspective wouldn't be visible.
      float z = .05, bestD = 1e9, zBest = z;
      for (int j=0; j<26; j++) {
        vec3 q = vec3(rel.x*ct - z*st, rel.y, rel.x*st + z*ct);
        float d = chainD(q, C.y, C.w);
        if (d < bestD) { bestD = d; zBest = z; }
        if (d < .00015 || z < -.05) break;
        z -= d*.9;
      }
      float cov = 1. - smoothstep(pix*.1, pix*1.15, bestD);
      if (cov <= 0.) continue;

      const vec2 k = vec2(1.,-1.);
      const float e = .0006;
      vec3 q0 = vec3(rel.x, rel.y, zBest);
      vec3 n = vec3(0.);
      for (int s=0; s<4; s++) {
        vec3 o4 = s == 0 ? k.xyy : s == 1 ? k.yyx : s == 2 ? k.yxy : k.xxx;
        vec3 w = q0 + o4*e;
        n += o4*chainD(vec3(w.x*ct - w.z*st, w.y, w.x*st + w.z*ct), C.y, C.w);
      }
      // y runs downward in the chain's frame; flip it back for the room.
      n = normalize(vec3(n.x, -n.y, n.z));
      vec3 r = reflect(vec3(0.,0.,-1.), n);
      r.xy += uPointer*vec2(.14,-.1);
      vec3 col = studio(normalize(r));
      col *= .78 + .22*pow(1. - clamp(n.z,0.,1.), 4.);
      return vec4(col/(1. + .14*col), cov);
    }
    return vec4(0.);
  }
  #endif

  void main(){
    float asp = uRes.x/uRes.y;
    vec2 p = vec2((vUv.x-.5)*asp, vUv.y-.5);
    vec3 c = vec3(.004,.0045,.006);

    if (uStars > .002) {
      vec2 q = p + vec2(uPointer.x*.006, uScroll*.05 + uPointer.y*.006);
      float s = stars(q*9., 1.) + .65*stars(q*18. + 40., 2.);
      c += vec3(.92,.95,1.)*s*uStars;
    }
    if (uCaustic > .002) {
      vec2 q = p*1.9 + vec2(0., uScroll*.1);
      c += vec3(.62,.68,.76)*pow(caustic(q)*.62, 1.7)*uCaustic*.8;
    }
    #if HERO
    {
      float pix = 1./uRes.y;
      // A faint moonlit haze around the crescent.
      float l = length((p - uObject.xy)/uObject.z);
      c += vec3(.038,.043,.06)*exp(-l*l*.42)*uVeins*smoothstep(.1,1.,uGrow);
      // Pushing in on the sculpture as the hero scrolls away.
      float z = 1. + uHero*uHero*1.5;
      vec4 m = scene((p - uObject.xy*(1. - uHero))/(uObject.z*z), pix/(uObject.z*z));
      c = mix(c, m.rgb, m.a*uVeins);
    }
    #endif
    #if CHAINS
    {
      vec4 ch = chains(p, 1./uRes.y);
      c = mix(c, ch.rgb, ch.a);
    }
    #endif
    c += (h21(gl_FragCoord.xy + fract(uTime)) - .5)/255.; // dither away banding
    o = vec4(c, 1.);
  }`;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  const UNIFORMS = ['uRes', 'uPointer', 'uTime', 'uVeins', 'uGrow', 'uHero', 'uStars', 'uCaustic', 'uChains', 'uChain', 'uScroll',
    'uName', 'uNameBox', 'uNameReady', 'uObject', 'uRot', 'uThornA', 'uThornB', 'uSide', 'uSlide'];
  function build(fsSource) {
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSource));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    const u = {};
    for (const n of UNIFORMS) u[n] = gl.getUniformLocation(prog, n);
    return { prog, u };
  }

  let heroProg, plain, chainProg, sideProg;
  try {
    heroProg = build(FS(true, false));
    plain = build(FS(false, false));
    chainProg = build(FS(false, true));
    sideProg = build(SIDE_FS);
  } catch (err) {
    console.error('LunaGL: shader failed', err);
    document.documentElement.classList.add('no-gl');
    return;
  }
  const vao = gl.createVertexArray();

  /* ---------- the name as a signed distance field ---------- */

  const nameEl = document.querySelector('.hero-name');
  const nameTex = gl.createTexture();
  let textReady = false;

  // 1D squared-distance transform (Felzenszwalb & Huttenlocher).
  function edt1d(f, d, v, z, n) {
    let k = 0; v[0] = 0; z[0] = -1e20; z[1] = 1e20;
    for (let q = 1; q < n; q++) {
      let s;
      do {
        const r = v[k];
        s = (f[q] - f[r] + q * q - r * r) / (q - r) / 2;
      } while (s <= z[k] && --k > -1);
      k++; v[k] = q; z[k] = s; z[k + 1] = 1e20;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      const r = v[k];
      d[q] = (q - r) * (q - r) + f[r];
    }
  }
  function distanceTo(mask, W, H, target) {
    const INF = 1e20, g = new Float64Array(W * H);
    for (let i = 0; i < W * H; i++) g[i] = mask[i] === target ? 0 : INF;
    const M = Math.max(W, H);
    const f = new Float64Array(M), d = new Float64Array(M), v = new Int32Array(M), z = new Float64Array(M + 1);
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) f[y] = g[y * W + x];
      edt1d(f, d, v, z, H);
      for (let y = 0; y < H; y++) g[y * W + x] = d[y];
    }
    for (let y = 0; y < H; y++) {
      const o = y * W;
      for (let x = 0; x < W; x++) f[x] = g[o + x];
      edt1d(f, d, v, z, W);
      for (let x = 0; x < W; x++) g[o + x] = Math.sqrt(d[x]);
    }
    return g;
  }
  function boxBlur(a, W, H, R, passes) {
    let src = a, tmp = new Float32Array(W * H);
    const norm = 1 / (2 * R + 1);
    for (let pass = 0; pass < passes; pass++) {
      for (let y = 0; y < H; y++) {
        const o = y * W;
        let s = 0;
        for (let x = -R; x <= R; x++) s += src[o + Math.min(Math.max(x, 0), W - 1)];
        for (let x = 0; x < W; x++) {
          tmp[o + x] = s * norm;
          s += src[o + Math.min(x + R + 1, W - 1)] - src[o + Math.max(x - R, 0)];
        }
      }
      for (let x = 0; x < W; x++) {
        let s = 0;
        for (let y = -R; y <= R; y++) s += tmp[Math.min(Math.max(y, 0), H - 1) * W + x];
        for (let y = 0; y < H; y++) {
          src[y * W + x] = s * norm;
          s += tmp[Math.min(y + R + 1, H - 1) * W + x] - tmp[Math.max(y - R, 0) * W + x];
        }
      }
    }
    return src;
  }

  function buildName() {
    const W = NAME_W, H = NAME_H;
    const cs = getComputedStyle(nameEl);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const family = cs.fontFamily, weight = cs.fontWeight;
    const label = nameEl.textContent.trim();
    const setFont = px => {
      ctx.font = `${weight} ${px}px ${family}`;
      if ('letterSpacing' in ctx) ctx.letterSpacing = (-.025 * px) + 'px';
    };
    setFont(400);
    const size = 400 * (W * NAME_FILL) / ctx.measureText(label).width;
    setFont(size);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#fff';
    const textW = ctx.measureText(label).width;
    const capH = ctx.measureText('L').actualBoundingBoxAscent;
    const x0 = (W - textW) / 2, y0 = H / 2 + capH / 2;
    ctx.fillText(label, x0, y0);

    // Soften first, so every corner is rounded like cast metal.
    const src = ctx.getImageData(0, 0, W, H).data;
    const a = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) a[i] = src[i * 4 + 3] / 255;
    boxBlur(a, W, H, Math.max(1, Math.round(size * .011)), 2);
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) mask[i] = a[i] > .5 ? 1 : 0;

    // Small thorns, added after softening so their tips stay needle-sharp. Each is placed relative
    // to its glyph's measured box (x, y as fractions, y up from the baseline), so they stay on the
    // strokes whatever font actually loaded: [x, y, half-width, direction°, length], sizes in em.
    const THORNS = {
      L: [[.15, 1, .085, 112, .2], [1, .1, .07, 8, .17], [.02, .03, .06, 222, .11]],
      u: [[.14, 1, .08, 108, .15], [.86, 1, .08, 72, .17], [.87, .03, .08, 292, .15]],
      n: [[.14, 1, .08, 118, .14], [.14, .03, .08, 248, .15], [.86, .03, .08, 292, .15]],
      a: [[.62, .98, .07, 68, .13], [.09, .74, .055, 158, .11], [.94, .03, .075, 298, .19]]
    };
    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < label.length; i++) {
      const ch = label[i], m = ctx.measureText(ch);
      const left = x0 + ctx.measureText(label.slice(0, i)).width - m.actualBoundingBoxLeft;
      const bw = m.actualBoundingBoxLeft + m.actualBoundingBoxRight, bh = m.actualBoundingBoxAscent;
      for (const [fx, fy, half, deg, len] of THORNS[ch] || []) {
        const dx = Math.cos(deg * DEG), dy = -Math.sin(deg * DEG);
        const bx = left + fx * bw - dx * size * .03, by = y0 - fy * bh - dy * size * .03;
        const hw = half * size, L = len * size + size * .03;
        const nx = -dy, ny = dx;
        const tx = bx + dx * L, ty = by + dy * L;
        ctx.beginPath();
        ctx.moveTo(bx + nx * hw, by + ny * hw);
        // Concave flanks, like the crescent's own thorns.
        ctx.quadraticCurveTo(bx + dx * L * .3 + nx * hw * .22, by + dy * L * .3 + ny * hw * .22, tx, ty);
        ctx.quadraticCurveTo(bx + dx * L * .3 - nx * hw * .22, by + dy * L * .3 - ny * hw * .22, bx - nx * hw, by - ny * hw);
        ctx.closePath();
        ctx.fill();
      }
    }
    const spikes = ctx.getImageData(0, 0, W, H).data;
    for (let i = 0; i < W * H; i++) if (spikes[i * 4 + 3] > 127) mask[i] = 1;

    const out = distanceTo(mask, W, H, 1), inside = distanceTo(mask, W, H, 0);

    // Signed distance in scene units; a touch of blur melts the ridge down each stroke's centre.
    const toScene = nameBox[2] * 2 / W;
    const sd = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) sd[i] = (mask[i] ? -(inside[i] - .5) : out[i] - .5) * toScene;
    boxBlur(sd, W, H, 3, 2);

    gl.bindTexture(gl.TEXTURE_2D, nameTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, W, H, 0, gl.RED, gl.FLOAT, sd);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    textReady = true;
    document.documentElement.classList.add('gl-ready');
  }

  const weightFor = () => getComputedStyle(nameEl).fontWeight;
  const fontsReady = (document.fonts && document.fonts.load)
    ? Promise.race([document.fonts.load(`${weightFor()} 200px Inter`), new Promise(r => setTimeout(r, 2000))])
    : Promise.resolve();
  fontsReady.catch(() => {}).then(buildName);

  /* ---------- sizing ---------- */

  // Raymarching scales with pixel count, so the hero has a firm budget. The scenes after it are cheap.
  const HERO_PIXELS = small ? 1.1e6 : 2.1e6;
  const MAX_PIXELS = small ? 1.8e6 : 2.6e6;
  let W = 1, H = 1, quality = Math.min(devicePixelRatio || 1, small ? 1.75 : 2);
  let cssW = 1, cssH = 1;
  const object = [0, 0, 1];
  const chainData = new Float32Array(16);

  // The edge chains, smaller first so the larger lie on top. Left and right differ on purpose.
  // Each: side, scale, inset, wander, frequency, phase, phase, how late in the scroll it arrives.
  const SIDE_CHAINS = [
    [-1, .74, .05, .036, 2.7, 1.1, .4, .2],
    [1, .68, .024, .028, 3.4, 3.6, 2.2, .28],
    [-1, 1, .034, .046, 1.9, 4.7, 2.9, 0],
    [1, .88, .062, .042, 2.3, .2, 5.1, .1],
  ];
  // Chains across the corners, in the positions Luna sketched. Ends are fractions of the half-width
  // and absolute heights, so the shape holds at any window size. They run past the screen at both ends.
  // Each: start, end, scale, wander, frequency, phase, phase, how late in the scroll it arrives.
  const CORNER_CHAINS = [
    [[.53, -.5], [.985, -.295], .82, .012, 6.4, 2.3, .9, .3],
    [[.76, .49], [1, .388], .74, .009, 9.1, 1, 4.2, .42],
    [[-.995, -.323], [-.8, -.5], .78, .01, 8.2, 5.1, 1.7, .36],
    [[-.99, .341], [-.62, .5], .9, .014, 6.9, .4, 3.3, .22],
  ];
  const sideData = new Float32Array(SIDE_COUNT * 12);
  const sideLayout = [];
  let sideStrip = .2, sideTop = .2, sideBottom = .24, sideNarrow = false;

  function layoutScene() {
    // The whole lockup, thorns to last letter, spans about -1.4..1.25 across and 1.32 each way up
    // and down. Scale it to fit whichever runs out first, and centre it.
    const asp = cssW / cssH;
    const scale = Math.min(.42 / 1.32, .46 * asp / 1.33);
    object[0] = .075 * scale;
    object[1] = -.012;
    object[2] = scale;

    // The chains frame the last section from either side, clear of its heading. Mirrored, with the
    // longer, inner pair carrying the charms. Each entry: x, length, sway phase, charm.
    const w = asp * .5, narrow = asp < .8;
    const outerX = w * (narrow ? .88 : .78), innerX = w * (narrow ? .7 : .63);
    const outer = narrow ? .17 : .3, inner = narrow ? .25 : .44;
    chainData.set([
      -outerX, outer, .4, 0,
      -innerX, inner, 2.1, 1,
      innerX, inner, 4.2, 1,
      outerX, outer, 5.4, 0
    ]);

    // How far the edge chains may wander in is set by the margin beside the page's content.
    const margin = Math.max(cssW - 1040, 0) / 2 / cssH;
    const reach = Math.min(Math.max(margin / .15, .32), 1.15);
    sideStrip = Math.min(.17 * reach + .035, w);
    sideNarrow = narrow;

    // Corner chains come first so the edge chains lie on top of them where they cross.
    sideLayout.length = 0;
    CORNER_CHAINS.forEach(([from, to, scale, wander, freq, f1, f2, late]) => {
      const ax = from[0] * w, ay = from[1], bx = to[0] * w, by = to[1];
      const ox = (ax + bx) / 2, oy = (ay + by) / 2, len = Math.hypot(bx - ax, by - ay);
      let nx = -(by - ay) / len, ny = (bx - ax) / len;
      if (nx * ox + ny * oy > 0) { nx = -nx; ny = -ny; }
      // Far enough out to start beyond the screen's corner.
      const cornerX = Math.sign(ox) * w, cornerY = Math.sign(oy) * .5;
      const out = Math.abs((cornerX - ox) * nx + (cornerY - oy) * ny);
      sideLayout.push({ corner: true, scale, inset: 0, wander, freq, f1, f2, late, ox, oy, nx, ny, span: out + wander * 1.3 + .035 });
    });
    SIDE_CHAINS.forEach(([side, scale, inset, wander, freq, f1, f2, late]) => {
      const thin = narrow ? .6 : 1, into = narrow ? inset * .25 * reach : inset * reach, swing = wander * reach;
      sideLayout.push({ corner: false, skip: narrow && scale < .8, scale: scale * thin, inset: into, wander: swing, freq, f1, f2, late, ox: side * w, oy: 0, nx: -side, ny: 0, span: into + swing * 1.24 + .02 });
    });
  }

  function drawSideChains(s, time) {
    const { prog, u: U } = sideProg;
    gl.useProgram(prog);
    gl.uniform2f(U.uRes, W, H);
    gl.uniform2f(U.uPointer, s.px, s.py);
    gl.uniform1f(U.uTime, time);
    gl.uniform1f(U.uSlide, s.scroll * .1);
    sideLayout.forEach((c, i) => {
      const k = Math.min(Math.max((s.side - c.late) / (1 - c.late), 0), 1);
      // On a tall phone only the two main edge chains show, finer and half off the edge, clear of the text.
      const off = c.skip || (sideNarrow && c.corner);
      const reveal = off ? 0 : k * k * (3 - 2 * k);
      sideData.set([c.scale, c.inset, reveal, (1 - reveal) * c.span, c.wander, c.freq, c.f1, c.f2, c.ox, c.oy, c.nx, c.ny], i * 12);
    });
    gl.uniform4fv(U.uSide, sideData);
    const strip = Math.ceil(sideStrip * H);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, strip, H);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.scissor(W - strip, 0, strip, H);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!sideNarrow) {
      // The middle of the top and bottom edges, where the corner chains reach in.
      const mid = W - strip * 2, top = Math.ceil(sideTop * H), bottom = Math.ceil(sideBottom * H);
      gl.scissor(strip, H - top, mid, top);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.scissor(strip, 0, mid, bottom);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
  }

  let heroOn = true;
  function resize() {
    const cw = canvas.clientWidth || innerWidth, ch = canvas.clientHeight || innerHeight;
    if (cw !== cssW || ch !== cssH) { cssW = cw; cssH = ch; layoutScene(); }
    const budget = heroOn ? HERO_PIXELS : MAX_PIXELS;
    const q = Math.min(quality, Math.sqrt(budget / (cssW * cssH)));
    const w = Math.round(cssW * q), h = Math.round(cssH * q);
    if (w !== W || h !== H) { W = canvas.width = w; H = canvas.height = h; }
  }

  // Trade resolution for frame rate, but only if it actually pays off. A slow rate isn't always
  // the GPU's fault (battery saver, a throttled window), and there a blurrier image buys nothing.
  let windowFrames = -90, windowMs = 0, trial = null, adaptDone = false;
  function adapt(dt) {
    if (adaptDone) return;
    if (++windowFrames <= 0) return; // ignore start-up work
    windowMs += dt;
    if (windowFrames < 60) return;
    const avg = windowMs / windowFrames;
    windowFrames = 0; windowMs = 0;
    if (trial) {
      if (avg > trial.before * .88) { quality = trial.quality; adaptDone = true; }
      trial = null;
    } else if (avg > 24 && quality > .7) {
      trial = { before: avg, quality };
      quality = Math.max(.7, quality * .8);
    }
  }

  // Column-major world → object rotation (mat3 uniform).
  function rotation(ax, ay, az) {
    const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
    return new Float32Array([
      cy * cz + sy * sx * sz, cx * sz, -sy * cz + cy * sx * sz,
      -cy * sz + sy * sx * cz, cx * cz, sy * sz + cy * sx * cz,
      sy * cx, -sx, cy * cx
    ]);
  }

  function render(s, time, dtMs) {
    if (dtMs < 200) adapt(dtMs);
    heroOn = s.veins > .002;
    resize();
    gl.viewport(0, 0, W, H);
    const { prog, u: U } = heroOn ? heroProg : s.chains > .002 ? chainProg : plain;
    gl.useProgram(prog);
    gl.uniform2f(U.uRes, W, H);
    gl.uniform2f(U.uPointer, s.px, s.py);
    gl.uniform1f(U.uTime, time);
    gl.uniform1f(U.uVeins, s.veins);
    gl.uniform1f(U.uGrow, s.grow);
    gl.uniform1f(U.uHero, s.hero);
    gl.uniform1f(U.uStars, s.stars);
    gl.uniform1f(U.uCaustic, s.caustic);
    gl.uniform1f(U.uChains, s.chains);
    gl.uniform4fv(U.uChain, chainData);
    gl.uniform1f(U.uScroll, s.scroll);
    if (heroOn) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, nameTex);
      gl.uniform1i(U.uName, 0);
      gl.uniform4fv(U.uNameBox, nameBox);
      gl.uniform1f(U.uNameReady, textReady ? 1 : 0);
      gl.uniform3fv(U.uObject, object);
      gl.uniform4fv(U.uThornA, thornA);
      gl.uniform4fv(U.uThornB, thornB);
      // A slow sway shows off real depth; the pointer leans it; scrolling turns it away.
      const h = s.hero;
      gl.uniformMatrix3fv(U.uRot, false, rotation(
        .07 + s.py * .09 + Math.sin(time * .17) * .04 + h * .55,
        -.1 + .11 * Math.sin(time * .13) + s.px * .17 + h * h * 1.5,
        h * .25
      ));
    }
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (s.side > .002) drawSideChains(s, time);
  }

  window.LunaGL = {
    render,
    relayout: () => {},
    isReady: () => textReady
  };
})();
