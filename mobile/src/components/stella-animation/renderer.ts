// Mobile port of `desktop/src/shell/ascii-creature/renderer.ts`.
//
// Differences from desktop:
//   * Atlas is uploaded via the pixel-pointer `texImage2D` overload (no DOM
//     canvas source).
//   * Texture flip / premultiplied-alpha `pixelStorei` are no-ops for
//     ArrayBufferView uploads, so we skip them.
//   * Buffer size comes from `gl.drawingBufferWidth/Height` (the GLView's
//     attached framebuffer), not a `<canvas>` element.

import type { ExpoWebGLRenderingContext } from "expo-gl";
import { DOT_COUNT, type GlyphAtlas } from "./glyph-atlas";
import { VERTEX_SOURCE, createProgram, getFragmentShader } from "./shader";

export type StellaRenderer = {
  render: (time: number, birth: number, flash: number) => void;
  setColors: (next: Float32Array) => void;
  destroy: () => void;
};

const createAnimationUniforms = (time: number) => {
  const cycle = time * 0.15;
  const phase = cycle - Math.floor(cycle / 3) * 3;
  let w1 =
    Math.max(0, 1 - Math.abs(phase)) + Math.max(0, 1 - Math.abs(phase - 3));
  let w2 = Math.max(0, 1 - Math.abs(phase - 1));
  let w3 = Math.max(0, 1 - Math.abs(phase - 2));
  const total = w1 + w2 + w3 || 1;
  w1 /= total;
  w2 /= total;
  w3 /= total;

  return { w1, w2, w3 };
};

export const initRenderer = (
  gl: ExpoWebGLRenderingContext,
  atlas: GlyphAtlas,
  gridWidth: number,
  gridHeight: number,
  initialColors: Float32Array,
  birthValue: number,
  flashValue: number,
): StellaRenderer | null => {
  const program = createProgram(gl, VERTEX_SOURCE, getFragmentShader());
  if (!program) return null;

  const positionBuffer = gl.createBuffer();
  if (!positionBuffer) {
    gl.deleteProgram(program);
    return null;
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );

  gl.useProgram(program);
  const aPosition = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(aPosition);
  gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

  const glyphTexture = gl.createTexture();
  if (!glyphTexture) {
    gl.deleteBuffer(positionBuffer);
    gl.deleteProgram(program);
    return null;
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, glyphTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    atlas.width,
    atlas.height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    atlas.pixels,
  );

  const uCanvasSize = gl.getUniformLocation(program, "u_canvasSize");
  const uGridSize = gl.getUniformLocation(program, "u_gridSize");
  const uTime = gl.getUniformLocation(program, "u_time");
  const uCharCount = gl.getUniformLocation(program, "u_charCount");
  const uBirth = gl.getUniformLocation(program, "u_birth");
  const uFlash = gl.getUniformLocation(program, "u_flash");
  const uGlyph = gl.getUniformLocation(program, "u_glyph");
  const uColors = gl.getUniformLocation(program, "u_colors[0]");
  const uListening = gl.getUniformLocation(program, "u_listening");
  const uSpeaking = gl.getUniformLocation(program, "u_speaking");
  const uVoiceEnergy = gl.getUniformLocation(program, "u_voiceEnergy");
  const uAspect = gl.getUniformLocation(program, "u_aspect");
  const uPhases = gl.getUniformLocation(program, "u_phases");

  if (
    !uCanvasSize ||
    !uGridSize ||
    !uTime ||
    !uCharCount ||
    !uBirth ||
    !uFlash ||
    !uGlyph ||
    !uColors
  ) {
    gl.deleteTexture(glyphTexture);
    gl.deleteBuffer(positionBuffer);
    gl.deleteProgram(program);
    return null;
  }

  const canvasW = gl.drawingBufferWidth;
  const canvasH = gl.drawingBufferHeight;
  const aspect = canvasH > 0 ? canvasW / canvasH : 1;

  gl.uniform2f(uCanvasSize, canvasW, canvasH);
  gl.uniform2f(uGridSize, gridWidth, gridHeight);
  gl.uniform1f(uCharCount, DOT_COUNT);
  gl.uniform1f(uBirth, birthValue);
  gl.uniform1f(uFlash, flashValue);
  gl.uniform1i(uGlyph, 0);
  gl.uniform3fv(uColors, initialColors);
  if (uListening) gl.uniform1f(uListening, 0);
  if (uSpeaking) gl.uniform1f(uSpeaking, 0);
  if (uVoiceEnergy) gl.uniform1f(uVoiceEnergy, 0);
  if (uAspect) gl.uniform1f(uAspect, aspect);

  gl.viewport(0, 0, canvasW, canvasH);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.clearColor(0, 0, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const phasesArr = new Float32Array(3);

  const render = (time: number, birth: number, flash: number) => {
    // expo-gl does not preserve GL state between `endFrameEXP()` calls the
    // way browser WebGL does — re-bind program / buffer / texture / viewport
    // every frame, otherwise only the first frame draws and the surface
    // freezes afterwards.
    gl.useProgram(program);

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, glyphTexture);
    gl.uniform1i(uGlyph, 0);

    gl.viewport(0, 0, canvasW, canvasH);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const u = createAnimationUniforms(time);

    gl.uniform1f(uTime, time);
    gl.uniform1f(uBirth, birth);
    gl.uniform1f(uFlash, flash);
    if (uPhases) {
      phasesArr[0] = u.w1;
      phasesArr[1] = u.w2;
      phasesArr[2] = u.w3;
      gl.uniform3fv(uPhases, phasesArr);
    }

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.endFrameEXP();
  };

  const setColors = (next: Float32Array) => {
    gl.useProgram(program);
    gl.uniform3fv(uColors, next);
  };

  const destroy = () => {
    gl.deleteTexture(glyphTexture);
    gl.deleteBuffer(positionBuffer);
    gl.deleteProgram(program);
  };

  return { render, setColors, destroy };
};
