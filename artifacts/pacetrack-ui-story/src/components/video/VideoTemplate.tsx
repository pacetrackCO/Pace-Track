import {
  VideoCanvas,
  type VideoAspectRatio,
  useVideoPlayer,
} from '@/lib/video';
import { AnimatePresence } from 'framer-motion';

import {
  HookScene,
  InterfaceScene,
  ScreensScene,
  OutroScene,
} from './StoryScenes';
import './story.css';

const SCENE_DURATIONS = {
  hook: 2300,
  interface: 2800,
  screens: 3000,
  outro: 2700,
};

const VIDEO_ASPECT_RATIO: VideoAspectRatio = '9:16';

export default function VideoTemplate() {
  const { currentScene } = useVideoPlayer({
    durations: SCENE_DURATIONS,
  });
  const scenes = [
    <HookScene key="hook" />,
    <InterfaceScene key="interface" />,
    <ScreensScene key="screens" />,
    <OutroScene key="outro" />,
  ];

  return (
    <VideoCanvas
      aspectRatio={VIDEO_ASPECT_RATIO}
      aria-label="Story animada de PaceTrack: nueva interfaz"
      style={{ backgroundColor: '#0f172a' }}
    >
      <AnimatePresence mode="wait" initial={false}>
        {scenes[currentScene]}
      </AnimatePresence>
    </VideoCanvas>
  );
}
