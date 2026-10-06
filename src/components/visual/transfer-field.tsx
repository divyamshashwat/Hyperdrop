"use client";

import { useEffect, useRef } from "react";
import { field, FieldMode, MODE_TARGETS } from "@/lib/visual/field-store";
import { FRAGMENT, VERTEX } from "./transfer-shader";

/**
 * Fullscreen WebGL canvas behind the UI. Independent from React: it runs its
 * own rAF loop and reads `field` directly. Quality adapts to the device and to
 * measured frame time so it never fights the interface for the GPU.
 */
export function TransferField() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "low-power" });
    if (!gl) {
      canvas.style.display = "none"; // the page background is already near-black
      return;
    }

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = compile(gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT);
    if (!vs || !fs) {
      console.warn("[field] shader failed:", gl.getShaderInfoLog(fs ?? vs!));
      canvas.style.display = "none";
      return;
    }
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const U = (n: string) => gl.getUniformLocation(prog, n);
    const u = {
      res: U("uRes"), time: U("uTime"), progress: U("uProgress"), speed: U("uTransferSpeed"),
      state: U("uConnectionState"), intensity: U("uIntensity"), pointer: U("uPointer"),
      reduced: U("uReducedMotion"), nodes: U("uNodes"), form: U("uForm"), flow: U("uFlow"),
      search: U("uSearch"), converge: U("uConverge"), pulse: U("uPulse"), jitter: U("uJitter"),
      lanes: U("uLanes"),
      flip: U("uFlip"),
      listen: U("uListen"),
      detect: U("uDetect"),
    };

    const mobile = matchMedia("(pointer: coarse)").matches || innerWidth < 700;
    const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = motionQuery.matches;
    const onMotion = () => (reduced = motionQuery.matches);
    motionQuery.addEventListener("change", onMotion);

    // Quality tiers: render scale and lane count. Adaptive downward when frames run long.
    // ?shader=off|minimal|low|medium|high lets the shader be A/B-tested against a transfer.
    const override = new URLSearchParams(location.search).get("shader");
    if (override === "off") {
      canvas.style.display = "none";
      motionQuery.removeEventListener("change", onMotion);
      return;
    }
    const TIERS: Record<string, { scale: number; lanes: number }> = {
      high: { scale: 1, lanes: 16 },
      medium: { scale: 0.8, lanes: 12 },
      low: { scale: 0.6, lanes: 10 },
      minimal: { scale: 0.45, lanes: 6 },
    };
    const tier = override ? TIERS[override] : undefined;
    // Hairlines need resolution: render near CSS-pixel density, and let adaptive quality shed it if slow.
    let scale = tier?.scale ?? (mobile ? 0.75 : 0.9);
    let lanes = tier?.lanes ?? (mobile ? 10 : 16);
    const resize = () => {
      const w = Math.max(2, Math.round(innerWidth * scale));
      const h = Math.max(2, Math.round(innerHeight * scale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    };
    resize();
    addEventListener("resize", resize);

    const onPointer = (e: PointerEvent) => {
      field.pointer[0] = (e.clientX / innerWidth) * 2 - 1;
      field.pointer[1] = -((e.clientY / innerHeight) * 2 - 1);
    };
    addEventListener("pointermove", onPointer, { passive: true });

    // Eased look parameters
    const cur = { nodes: 0.2, form: 0.1, flow: 0, search: 0, converge: 0, intensity: 0.12, progress: 0, speed: 0, jitter: 0, px: 0, py: 0, listen: 0 };
    const ease = (v: number, target: number, dt: number, rate: number) => v + (target - v) * (1 - Math.exp(-dt * rate));

    let raf = 0;
    let last = performance.now();
    let clock = 0;
    let slowFor = 0;
    let running = true;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      // While bytes are actually moving the transfer always wins: render at 30 fps with fewer lanes.
      const transferring = field.mode === FieldMode.Sending || field.mode === FieldMode.Completing;
      const minGap = reduced ? 1000 / 15 : mobile || transferring ? 1000 / 30 : 0;
      if (now - last < minGap) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      clock += dt;

      // Nearby re-shapes the resting field: listening quiets the lens, hearing begins a path, a lock forms it.
      const base = MODE_TARGETS[field.mode];
      const pre = field.mode === FieldMode.Idle || field.mode === FieldMode.Waiting;
      const target =
        pre && field.proximity === 1
          ? { ...base, nodes: 1, form: 0.22, search: 0.3, flow: 0 }
          : pre && field.proximity === 2
            ? { ...base, nodes: 1, form: 0.55, search: 0.8, flow: 0.15, intensity: base.intensity + 0.05 }
            : pre && field.proximity === 3
              ? { ...base, nodes: 1, form: 1, search: 0.2, flow: 0.25, intensity: base.intensity + 0.08 }
              : base;
      cur.listen = ease(cur.listen, field.proximity > 0 && pre ? 1 : 0, dt, 2.5);
      // After an error, settle back to a calm waiting look.
      const errAge = field.errorAt >= 0 ? (now - field.errorAt) / 1000 : 99;
      const erroring = field.mode === FieldMode.Error && errAge < 1.6;
      const jitterTarget = erroring && !reduced ? 1 : 0;

      const r = field.mode === FieldMode.Sending ? 1.6 : 1.1;
      cur.nodes = ease(cur.nodes, target.nodes, dt, r);
      cur.form = ease(cur.form, target.form, dt, 0.9);
      cur.flow = ease(cur.flow, target.flow, dt, 1.4);
      cur.search = ease(cur.search, target.search, dt, 1.2);
      cur.converge = ease(cur.converge, target.converge, dt, 1.2);
      cur.jitter = ease(cur.jitter, jitterTarget, dt, jitterTarget ? 9 : 2.2);
      cur.progress = ease(cur.progress, field.progress, dt, 3);
      cur.speed = ease(cur.speed, field.speed, dt, 1.5);
      cur.px = ease(cur.px, field.pointer[0], dt, 2);
      cur.py = ease(cur.py, field.pointer[1], dt, 2);

      // Speed adds energy, but the visual system stays calm: intensity is capped.
      const intensity = Math.min(0.5, target.intensity + (field.mode === FieldMode.Sending ? cur.speed * 0.18 : 0));
      cur.intensity = ease(cur.intensity, intensity, dt, 1.5);

      const pulse = field.pulseAt >= 0 && field.mode === FieldMode.Complete ? (now - field.pulseAt) / 1000 : -1;

      gl.uniform2f(u.res, canvas.width, canvas.height);
      gl.uniform1f(u.time, clock);
      gl.uniform1f(u.progress, field.mode === FieldMode.Complete ? 1 : cur.progress);
      gl.uniform1f(u.speed, cur.speed);
      gl.uniform1f(u.state, field.mode);
      gl.uniform1f(u.intensity, cur.intensity);
      gl.uniform2f(u.pointer, cur.px, cur.py);
      gl.uniform1f(u.reduced, reduced ? 1 : 0);
      gl.uniform1f(u.nodes, cur.nodes);
      gl.uniform1f(u.form, cur.form);
      gl.uniform1f(u.flow, cur.flow);
      gl.uniform1f(u.search, cur.search);
      gl.uniform1f(u.converge, cur.converge);
      gl.uniform1f(u.pulse, reduced && pulse >= 0 ? 0.6 : pulse);
      gl.uniform1f(u.jitter, cur.jitter);
      gl.uniform1f(u.lanes, transferring ? Math.min(lanes, 10) : lanes);
      gl.uniform1f(u.flip, field.receiver ? 1 : 0);
      gl.uniform1f(u.listen, reduced ? cur.listen * 0.5 : cur.listen);
      gl.uniform1f(u.detect, field.detectAt >= 0 && now - field.detectAt < 3000 ? (now - field.detectAt) / 1000 : -1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Adaptive quality: if we're consistently slow, shed resolution, then lanes.
      if (dt > 0.03) slowFor += dt;
      else slowFor = Math.max(0, slowFor - dt * 0.5);
      if (slowFor > 1.5) {
        slowFor = 0;
        if (scale > 0.36) {
          scale *= 0.8;
          resize();
        } else if (lanes > 6) lanes -= 2;
      }
    };
    raf = requestAnimationFrame(frame);

    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        running = false;
      } else if (!running) {
        running = true;
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    const onLost = (e: Event) => {
      e.preventDefault();
      cancelAnimationFrame(raf);
    };
    canvas.addEventListener("webglcontextlost", onLost);

    return () => {
      cancelAnimationFrame(raf);
      removeEventListener("resize", resize);
      removeEventListener("pointermove", onPointer);
      document.removeEventListener("visibilitychange", onVisibility);
      motionQuery.removeEventListener("change", onMotion);
      canvas.removeEventListener("webglcontextlost", onLost);
    };
  }, []);

  return <canvas ref={ref} aria-hidden="true" className="fixed inset-0 z-0 h-full w-full bg-[#0b0b0a]" />;
}
