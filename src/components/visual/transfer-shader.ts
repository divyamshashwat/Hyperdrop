/**
 * The transfer field: an invisible network made visible.
 *
 * Two quiet points of light, sender and receiver, laid along the screen's long
 * axis (vertical on a phone, horizontal on a desktop). Between them, a lens of
 * hairline field lines. When bytes actually move, soft pulses of light travel
 * from sender to receiver; the delivered stretch warms to ember. Cheap analytic
 * math only: no noise textures, no fbm, one fullscreen triangle.
 */

export const VERTEX = /* glsl */ `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

export const FRAGMENT = /* glsl */ `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2  uRes;
uniform float uTime;
uniform float uProgress;        // 0..1, real bytes delivered
uniform float uTransferSpeed;   // 0..1, real throughput
uniform float uConnectionState; // informational; the look comes from the eased uniforms below
uniform float uIntensity;
uniform vec2  uPointer;
uniform float uReducedMotion;
uniform float uNodes;
uniform float uForm;
uniform float uFlow;
uniform float uSearch;
uniform float uConverge;
uniform float uPulse;           // seconds since completion, < 0 when none
uniform float uJitter;
uniform float uLanes;
uniform float uFlip;            // 1 on a receiving device: the sender sits at the top, data flows down to you
uniform float uListen;          // Nearby: 0..1, this device is listening for the other one
uniform float uDetect;          // Nearby: seconds since the other device was heard, < 0 when not

const float PI = 3.14159265;

float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }
float hash2(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  float s = min(uRes.x, uRes.y);
  float px = 1.0 / s;
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / s;          // short side spans 1.0
  bool vertical = uRes.y > uRes.x;
  float halfLong = 0.5 * max(uRes.x, uRes.y) / s;
  p += uPointer * 0.006 * (1.0 - uReducedMotion);

  // Node placement. Phone: "this device" sits just above the thumb bar, the other
  // device up by the header, both clear of the content column. Desktop: left -> right.
  float yNear = -halfLong * 0.60;
  float yFar = halfLong * 0.88;
  vec2 A;
  vec2 B;
  if (vertical) {
    bool flip = uFlip > 0.5;
    A = vec2(0.0, flip ? yFar : yNear);
    B = vec2(0.0, flip ? yNear : yFar);
  } else {
    float Lh = halfLong * 0.74;
    A = vec2(-Lh, 0.0);
    B = vec2(Lh, 0.0);
  }
  vec2 axis = normalize(B - A);
  float span = length(B - A);
  // u runs 0 at the sender to 1 at the receiver; c is the distance across the axis.
  float u = dot(p - A, axis) / span;
  float c = dot(p - A, vec2(-axis.y, axis.x));
  float a = (u - 0.5) * span;
  float uc = clamp(u, 0.0, 1.0);
  float W = vertical ? 0.40 : 0.27;
  float time = uTime * (1.0 - 0.85 * uReducedMotion);

  vec3 warm  = vec3(0.95, 0.93, 0.89);
  vec3 ember = vec3(1.00, 0.72, 0.50);
  vec3 light = vec3(0.0);

  // max(): sin(PI) is a hair below zero in float, and pow() of a negative is NaN (a black band).
  float env = pow(max(sin(PI * uc), 0.0), 0.85);
  float conv = 1.0 - 0.55 * uConverge * smoothstep(0.25, 1.0, uc);
  float reach = smoothstep(uForm * 1.06, uForm * 1.06 - 0.08, u);
  float delivered = smoothstep(uProgress + 0.02, uProgress - 0.02, u) * step(0.001, uProgress);
  float speed = 0.03 + 0.20 * uFlow * (0.4 + uTransferSpeed);
  float twin = smoothstep(0.35, 0.8, uTransferSpeed);

  /* ---- field lines and travelling light ---- */
  if (u > -0.02 && u < 1.02 && abs(c) < W + 0.06) {
    for (int i = 0; i < 16; i++) {
      float fi = float(i);
      if (fi >= uLanes) break;
      float k = ((fi + 0.5) / uLanes) * 2.0 - 1.0;     // symmetric: no line through the middle
      float h = hash(fi + 1.3);
      float y = k * W * env * conv;
      y += 0.006 * sin(uc * 7.0 + time * 0.35 + fi * 1.9) * env;          // breathing
      y += 0.030 * uSearch * sin(uc * 4.0 - time * 0.9 + fi * 2.7) * env; // searching for a path
      y += uJitter * 0.040 * (hash(fi + floor(uTime * 9.0)) - 0.5) * env; // error: brief instability
      float d = abs(c - y);
      float edge = 1.0 - abs(k) * 0.55;

      float hair = clamp(1.0 - d / (1.3 * px), 0.0, 1.0) * 0.30 * edge * reach;
      float glow = exp(-d * d / 0.0004) * 0.045 * edge * reach;

      float ph = fract(time * speed * (0.8 + 0.4 * h) + h * 9.0);
      float d1 = uc - ph;
      float d2 = uc - fract(ph + 0.5);
      float pulse = (exp(-d1 * d1 / 0.0016) + twin * exp(-d2 * d2 / 0.0016)) * uFlow * reach * edge;
      float core = clamp(1.0 - d / (2.2 * px), 0.0, 1.0);
      float halo = exp(-d * d / 0.00025);

      vec3 col = mix(warm, ember, delivered * 0.75);
      light += col * (hair + glow) * (0.6 + 0.6 * delivered);
      light += col * pulse * (core * 0.85 + halo * 0.3);
    }
    // the front of the transfer: a soft band that advances with real progress
    float front = exp(-pow((u - uProgress) * 22.0, 2.0)) * step(0.001, uProgress) * uFlow;
    light += ember * front * 0.09 * smoothstep(W * env * conv + 0.02, 0.0, abs(c));
    // faint haze inside the lens
    light += warm * exp(-c * c / (W * W * 0.6)) * env * 0.018 * uForm;
  }

  /* ---- the two devices ---- */
  float rA = length(p - A);
  float rB = length(p - B);
  float breathe = 0.85 + 0.15 * sin(time * 0.5);
  float nA = smoothstep(0.010, 0.006, rA) * 0.9 + exp(-rA * rA * 500.0) * 0.30 * breathe + exp(-rA * 6.0) * 0.06;
  float nB = smoothstep(0.010, 0.006, rB) * 0.9 + exp(-rB * rB * 500.0) * 0.30 * breathe + exp(-rB * 6.0) * 0.06;
  float pulse = uPulse >= 0.0 ? uPulse : 99.0;
  float recv = clamp(smoothstep(0.0, 0.3, uProgress) * uFlow + (1.0 - smoothstep(0.0, 2.5, pulse)) * 0.9, 0.0, 1.0);
  light += (warm * nA + mix(warm, ember, recv) * nB) * uNodes;

  /* ---- Nearby: proximity, not sound. A field breathes around this device while it listens ---- */
  if (uListen > 0.001) {
    float rings = 0.0;
    for (int k = 0; k < 3; k++) {
      float ph = fract(time * 0.22 + float(k) / 3.0);
      float r = 0.05 + ph * 0.42;
      rings += exp(-pow((rA - r) * 46.0, 2.0)) * (1.0 - ph) * (1.0 - ph);
    }
    light += warm * rings * uListen * 0.30;
  }
  // ...and one quick pulse the moment it hears the other device.
  if (uDetect >= 0.0) {
    float rd = 0.05 + uDetect * 0.6;
    light += warm * exp(-pow((rA - rd) * 36.0, 2.0)) * exp(-uDetect * 2.2) * 0.6;
  }

  /* ---- completion: one restrained wave from the receiver ---- */
  float pr = pulse * 0.45;
  light += ember * exp(-pow((rB - pr) * 48.0, 2.0)) * exp(-pulse * 1.4) * step(0.0, uPulse) * 0.30;

  /* ---- keep reading surfaces calm ---- */
  float mask = vertical ? 1.0 - 0.40 * exp(-c * c * 18.0) : 1.0 - 0.60 * exp(-(a * a * 2.0 + c * c * 12.0));
  light *= mask;

  vec3 col = vec3(0.043, 0.043, 0.039) + light * uIntensity * 2.2;
  vec2 q = gl_FragCoord.xy / uRes - 0.5;
  col *= 1.0 - 0.45 * dot(q, q);
  col += (hash2(gl_FragCoord.xy + fract(uTime * 7.3) * 113.0) - 0.5) * 0.014;   // fine grain
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
