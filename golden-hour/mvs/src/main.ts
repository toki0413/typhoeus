import { createWorld } from './sim/world';
import { buildDebrief } from './eval/debrief';
import { createScene, CAMERA_FRUSTUM } from './render/scene';
import { createAgents } from './render/agents';
import { createSmoke } from './render/smoke';
import { createDoor } from './render/door';
import { createFireGlow } from './render/fire';
import { createCorridorDetails } from './render/corridor';
import { createSpatialAudio } from './render/spatial';
import { createHeroCam } from './render/heroCam';
import { loadCrewModel } from './render/glbCrew';
import { createHud } from './ui/hud';
import { createDoorUi } from './ui/door';
import { createActions } from './ui/actions';
import { createIncidentUi } from './ui/incidents';
import { createRadio } from './ui/radio';
import { createMoveUi } from './ui/move';
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
import { completeExtraction } from './sim/crew';
import { SCENARIOS, nextScenario as pickNextScenario } from './content/scenarios';

const canvas = document.getElementById('app') as HTMLCanvasElement;
const hudRoot = document.getElementById('hud')!;
const moveRoot = document.getElementById('move')!;
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
    audio.setVolume(next.volume);
  },
});
shell.setStats(records);
shell.showTitle();

function createApp(kit: ReturnType<typeof createScene>): App {
  const { scene, camera, renderer, heroLights } = kit;
  renderer.setSize(window.innerWidth, window.innerHeight);
  canvas.replaceWith(renderer.domElement);
  renderer.domElement.id = 'app';

  const CAMERA_HOME = { x: 28, y: 24, z: 28 };

  const sim = createWorld(records.lastSeed || SCENARIOS[0].seed);
  const spatial = createSpatialAudio(camera);
  const heroCam = createHeroCam({ reducedMotion: () => settings.reducedMotion });
  const agents = createAgents(scene);
  let keyX = 0;
  let keyZ = 0;
  let padX = 0;
  let padZ = 0;
  const moveUi = createMoveUi(moveRoot, {
    onMove: (x, z) => {
      padX = x;
      padZ = z;
    },
    onAction: () => agents.performAction(sim),
  });
  const smoke = createSmoke(scene);
  const doorMesh = createDoor(scene);
  const fireGlow = createFireGlow(scene);
  const corridor = createCorridorDetails(scene);
  const hud = createHud(hudRoot);
  const doorUi = createDoorUi(doorRoot, sim);
  const actions = createActions(actionsRoot, sim);
  const incidents = createIncidentUi(incidentRoot, sim);
  const radio = createRadio(radioRoot);

  if (import.meta.env.DEV) {
    const debugWindow = window as unknown as {
      __gh: {
        audio: typeof audio;
        sim: typeof sim;
        agents: typeof agents;
        doorMesh: typeof doorMesh;
        crewClips: () => string[];
        hero: {
          active: () => boolean;
          strength: () => number;
          autoRuns: () => number;
          start: () => void;
        };
        finishRun: () => void;
      };
    };
    debugWindow.__gh = {
      audio,
      sim,
      agents,
      doorMesh,
      crewClips: () => agents.clipNames(),
      hero: {
        active: () => heroCam.active(),
        strength: () => heroCam.strength,
        autoRuns: () => heroAutoRuns,
        start: () => heroCam.trigger(agents.crewFocus()),
      },
      finishRun: () => completeExtraction(sim),
    };
  }

  void loadCrewModel(`${import.meta.env.BASE_URL}assets/firefighter.glb`)
    .then((model) => {
      if (model) agents.useCrewModel(model);
    })
    .catch((error) => {
      if (import.meta.env.DEV) {
        console.warn('消防员 GLB 加载失败，继续使用程序化模型', error);
      }
    });

  let paused = false;
  let debriefShown = false;
  let debriefScheduled = false;
  let debriefAt = 0;
  let prevDoorAngle = 0;
  let introAt = 0;
  let acc = 0;
  let last = performance.now();
  let hudTimer = 0;
  let heroArmed = false;
  let heroAutoRuns = 0;
  let heroUiOn = false;

  function startRun(): void {
    if (sim.phase !== 'plan') return;
    shell.hide();
    document.body.dataset.run = 'playing';
    paused = false;
    audio.unlock(settings.muted);
    audio.setVolume(settings.volume);
    audio.setActive(true);
    beginRun(sim);
    acc = 0;
    last = performance.now();
    introAt = last;
    prevDoorAngle = doorMesh.getAngle();
    debriefScheduled = false;
    debriefAt = 0;
    heroArmed = false;
    heroAutoRuns = 0;
    heroCam.cancel();
    keyX = 0;
    keyZ = 0;
    padX = 0;
    padZ = 0;
    agents.move(0, 0);
    agents.reset();
  }

  function retry(): void {
    restart(sim);
    debriefRoot.style.display = 'none';
    debriefShown = false;
    debriefScheduled = false;
    debriefAt = 0;
    prevDoorAngle = 0;
    startRun();
  }

  function nextScenarioRun(): void {
    const next = pickNextScenario(sim.seed, records.seedPlays);
    restart(sim, next.seed);
    debriefRoot.style.display = 'none';
    debriefShown = false;
    debriefScheduled = false;
    debriefAt = 0;
    prevDoorAngle = 0;
    records = { ...records, lastSeed: next.seed };
    saveRecords(storage, records);
    shell.setStats(records);
    startRun();
  }

  function returnToTitle(): void {
    restart(sim);
    debriefRoot.style.display = 'none';
    debriefShown = false;
    debriefScheduled = false;
    debriefAt = 0;
    prevDoorAngle = 0;
    paused = false;
    audio.setActive(false);
    heroArmed = false;
    heroCam.cancel();
    keyX = 0;
    keyZ = 0;
    padX = 0;
    padZ = 0;
    agents.move(0, 0);
    agents.reset();
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
    const frustum = CAMERA_FRUSTUM;
    camera.left = -frustum * aspect;
    camera.right = frustum * aspect;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  pauseButton.addEventListener('click', () => setPaused(true));

  window.addEventListener('keydown', (e) => {
    const moveKey =
      e.code === 'KeyA' ||
      e.code === 'KeyD' ||
      e.code === 'KeyW' ||
      e.code === 'KeyS' ||
      e.code === 'ArrowLeft' ||
      e.code === 'ArrowRight' ||
      e.code === 'ArrowUp' ||
      e.code === 'ArrowDown';
    if (moveKey && sim.phase === 'execute' && !paused) e.preventDefault();
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') keyX = -1;
    if (e.code === 'KeyD' || e.code === 'ArrowRight') keyX = 1;
    if (e.code === 'KeyW' || e.code === 'ArrowUp') keyZ = -1;
    if (e.code === 'KeyS' || e.code === 'ArrowDown') keyZ = 1;
    if (e.code === 'KeyE' && sim.phase === 'execute' && !paused) {
      agents.performAction(sim);
    }
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
    keyX = 0;
    keyZ = 0;
    padX = 0;
    padZ = 0;
    if (sim.phase === 'execute' && !paused) setPaused(true);
  });

  window.addEventListener('keyup', (e) => {
    if ((e.code === 'KeyA' || e.code === 'ArrowLeft') && keyX === -1) keyX = 0;
    if ((e.code === 'KeyD' || e.code === 'ArrowRight') && keyX === 1) keyX = 0;
    if ((e.code === 'KeyW' || e.code === 'ArrowUp') && keyZ === -1) keyZ = 0;
    if ((e.code === 'KeyS' || e.code === 'ArrowDown') && keyZ === 1) keyZ = 0;
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
      audio.update(sim, spatial.read());
    }

    // 让门扇先转完、吱呀声落地，再盖复盘页。
    if (sim.phase === 'debrief' && !debriefScheduled) {
      debriefScheduled = true;
      debriefAt = now + 750;
    }

    if (debriefScheduled && !debriefShown && now >= debriefAt) {
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
        nextScenarioName: pickNextScenario(sim.seed, records.seedPlays).name,
        onRestart: retry,
        onNextScenario: nextScenarioRun,
        onTitle: returnToTitle,
      });
    }

    agents.move(
      paused ? 0 : keyX || padX,
      paused ? 0 : keyZ || padZ
    );
    agents.update(sim, Math.min(raw, 0.25));
    corridor.setCollapsed(sim.stairs.collapsed);

    // 玩家把班组走到门口并停稳后，才推近英雄镜头。
    if (running && agents.nearDoor() && agents.speed() < 0.12 && !sim.door.opened && !heroArmed) {
      heroArmed = true;
      heroAutoRuns += 1;
      heroCam.trigger(agents.crewFocus());
    }
    if (sim.door.opened || sim.phase !== 'execute' || !agents.nearDoor()) heroCam.release();
    heroCam.update(paused ? 0 : Math.min(raw, 0.25));
    heroLights.key.intensity = 12 * heroCam.strength;
    heroLights.rim.intensity = 7 * heroCam.strength;
    const heroOn = heroCam.strength > 0.12;
    if (heroOn !== heroUiOn) {
      heroUiOn = heroOn;
      document.body.dataset.hero = heroOn ? 'on' : 'off';
    }

    const contextual = agents.action();
    const floorNow = agents.floor();
    const baseHint = agents.carrying()
      ? '将被困者带到出口'
      : floorNow === 1
        ? '前往 202 门口'
        : '上楼搜救';
    const distance = agents.carrying()
      ? Math.max(0, 9.4 - agents.crewX())
      : floorNow === 1
        ? Math.abs(agents.crewX())
        : Math.min(Math.abs(agents.crewX() + 11), Math.abs(agents.crewX() - 10.5));
    moveUi.update({
      visible: !paused && sim.phase === 'execute' && !debriefShown,
      hint: contextual?.kind === 'blocked' ? contextual.label : baseHint,
      distance,
      action:
        contextual && contextual.kind !== 'blocked' ? contextual.label : null,
    });

    smoke.update(sim);
    doorMesh.update(sim);
    fireGlow.update(sim);
    const doorAngle = doorMesh.getAngle();
    const hingeRate = Math.abs(doorAngle - prevDoorAngle) * 60;
    prevDoorAngle = doorAngle;
    if (sim.door.opened && !debriefShown && hingeRate > 0.02) {
      audio.setDoorMotion(hingeRate);
    }
    doorUi.update(sim, agents.nearDoor());
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
    camera.position.x = CAMERA_HOME.x + Math.sin(now * 0.009) * shake + heroCam.offset.x;
    camera.position.y = CAMERA_HOME.y + Math.cos(now * 0.012) * shake * 0.6 + heroCam.offset.y;
    camera.position.z = CAMERA_HOME.z + heroCam.offset.z;

    // 开始训练时轻微推近，建立镜头感；减少动态时直接停在最终视角。
    const intro = settings.reducedMotion ? 1 : Math.min(1, (now - introAt) / 1400);
    const eased = 1 - Math.pow(1 - intro, 3);
    camera.zoom = (1.02 + 0.06 * eased) * heroCam.zoom;
    camera.updateProjectionMatrix();
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
