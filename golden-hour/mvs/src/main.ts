import { createWorld } from './sim/world';
import { buildDebrief } from './eval/debrief';
import { createScene } from './render/scene';
import { createAgents } from './render/agents';
import { createSmoke } from './render/smoke';
import { createDoor } from './render/door';
import { createCorridorDetails } from './render/corridor';
import { createHud } from './ui/hud';
import { createDoorUi } from './ui/door';
import { createActions } from './ui/actions';
import { createIncidentUi } from './ui/incidents';
import { createRadio } from './ui/radio';
import { renderDebrief } from './ui/debrief';
import { createShell } from './ui/shell';
import { createAudio } from './audio/engine';
import {
  applySettings,
  loadSettings,
  saveSettings,
  type Settings,
  type StorageLike,
} from './app/prefs';
import {
  loadRecords,
  recordRun,
  saveRecords,
  type TrainingRecord,
} from './app/records';
import { beginRun, advance, restart } from './app/session';

const canvas = document.getElementById('app') as HTMLCanvasElement;
const hudRoot = document.getElementById('hud')!;
const doorRoot = document.getElementById('door-ui')!;
const actionsRoot = document.getElementById('actions')!;
const incidentRoot = document.getElementById('incidents')!;
const radioRoot = document.getElementById('radio')!;
const debriefRoot = document.getElementById('debrief')!;
const shellRoot = document.getElementById('shell')!;
const vignette = document.getElementById('vignette')!;
const pauseButton = document.getElementById('pause-btn')!;

function safeStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const storage = safeStorage();
const prefersReducedMotion =
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

let settings = loadSettings(storage, prefersReducedMotion);
applySettings(document, settings);

let records: TrainingRecord = loadRecords(storage);

const audio = createAudio();

interface App {
  start: () => void;
  resume: () => void;
  restart: () => void;
  title: () => void;
}

let app: App | null = null;

const shell = createShell(shellRoot, {
  settings,
  onStart: () => app?.start(),
  onResume: () => app?.resume(),
  onRestart: () => app?.restart(),
  onTitle: () => app?.title(),
  onSettingsChange: (next: Settings) => {
    settings = next;
    saveSettings(storage, next);
    applySettings(document, next);
    audio.setMuted(next.muted);
  },
});
shell.setStats(records);
shell.showTitle();

function createApp(kit: ReturnType<typeof createScene>): App {
  const { scene, camera, renderer } = kit;
  renderer.setSize(window.innerWidth, window.innerHeight);
  canvas.replaceWith(renderer.domElement);
  renderer.domElement.id = 'app';

  const CAMERA_HOME = { x: 28, y: 24, z: 28 };

  const sim = createWorld('GH-FIRE-MVS');
  const agents = createAgents(scene);
  const smoke = createSmoke(scene);
  const doorMesh = createDoor(scene);
  createCorridorDetails(scene);
  const hud = createHud(hudRoot);
  const doorUi = createDoorUi(doorRoot, sim);
  const actions = createActions(actionsRoot, sim);
  const incidents = createIncidentUi(incidentRoot, sim);
  const radio = createRadio(radioRoot);

  let paused = false;
  let debriefShown = false;
  let acc = 0;
  let last = performance.now();
  let hudTimer = 0;

  function startRun(): void {
    if (sim.phase !== 'plan') return;
    shell.hide();
    document.body.dataset.run = 'playing';
    paused = false;
    audio.unlock(settings.muted);
    audio.setActive(true);
    beginRun(sim);
    acc = 0;
    last = performance.now();
  }

  function retry(): void {
    restart(sim);
    debriefRoot.style.display = 'none';
    debriefShown = false;
    startRun();
  }

  function returnToTitle(): void {
    restart(sim);
    debriefRoot.style.display = 'none';
    debriefShown = false;
    paused = false;
    audio.setActive(false);
    document.body.dataset.run = 'title';
    shell.showTitle();
  }

  function setPaused(next: boolean): void {
    if (sim.phase !== 'execute') return;
    paused = next;
    audio.setActive(!next);
    document.body.dataset.run = next ? 'paused' : 'playing';
    if (next) shell.showPause();
    else shell.hide();
  }

  window.addEventListener('resize', () => {
    const aspect = window.innerWidth / window.innerHeight;
    const frustum = 16;
    camera.left = -frustum * aspect;
    camera.right = frustum * aspect;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  pauseButton.addEventListener('click', () => setPaused(true));

  window.addEventListener('keydown', (e) => {
    const onButton = (e.target as HTMLElement | null)?.tagName === 'BUTTON';
    if (e.code === 'Enter' && document.body.dataset.run === 'title' && !onButton) {
      e.preventDefault();
      startRun();
      return;
    }
    if (e.code === 'Escape' && sim.phase === 'execute') {
      e.preventDefault();
      setPaused(!paused);
      return;
    }
    if (import.meta.env.DEV && e.code === 'KeyT' && sim.phase === 'execute' && !paused) {
      for (let i = 0; i < 600; i++) advance(sim, 1 / 20);
    }
  });

  window.addEventListener('blur', () => {
    if (sim.phase === 'execute' && !paused) setPaused(true);
  });

  const DT = 1 / 20;

  function frame(now: number) {
    requestAnimationFrame(frame);
    const raw = Math.min((now - last) / 1000, 0.25);
    last = now;

    const running = sim.phase === 'execute' && !paused;

    if (running) {
      acc += raw;
      while (acc >= DT) {
        const result = advance(sim, DT);
        acc -= DT;
        if (result.enteredDebrief) break;
      }
      audio.update(sim);
    }

    if (sim.phase === 'debrief' && !debriefShown) {
      debriefShown = true;
      const card = buildDebrief(sim);
      records = recordRun(records, card);
      saveRecords(storage, records);
      shell.setStats(records);
      audio.setActive(false);
      document.body.dataset.run = 'debrief';
      debriefRoot.style.display = 'block';
      renderDebrief(debriefRoot, card, {
        history: records,
        onRestart: retry,
        onTitle: returnToTitle,
      });
    }

    agents.update(sim);
    smoke.update(sim);
    doorMesh.update(sim);
    doorUi.update(sim);
    actions.update(sim);
    incidents.update(sim);
    radio.update(sim);
    hudTimer += raw;
    if (hudTimer >= 0.1) {
      hudTimer = 0;
      hud.update(sim);
    }

    const shake = running && !settings.reducedMotion
      ? Math.min(0.14, sim.exposure.smoke * 0.22)
      : 0;
    camera.position.x = CAMERA_HOME.x + Math.sin(now * 0.009) * shake;
    camera.position.y = CAMERA_HOME.y + Math.cos(now * 0.012) * shake * 0.6;
    vignette.style.opacity = running
      ? String(Math.min(0.5, sim.exposure.smoke * 0.75))
      : '0';

    renderer.render(scene, camera);
  }

  requestAnimationFrame(frame);

  return { start: startRun, resume: () => setPaused(false), restart: retry, title: returnToTitle };
}

let sceneKit: ReturnType<typeof createScene> | null = null;
try {
  sceneKit = createScene();
} catch {
  sceneKit = null;
}

if (sceneKit) {
  app = createApp(sceneKit);
} else {
  shell.setNotice('当前设备无法创建 3D 场景（WebGL 不可用）。请换用支持 WebGL 的浏览器或设备再开始训练。');
}
