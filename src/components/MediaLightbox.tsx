/**
 * MediaLightbox — the single image viewer used everywhere in the app.
 *
 * A thin wrapper around yet-another-react-lightbox configured once with our
 * plugins (zoom, captions, counter, download) and theme, so the URL-scan grid
 * and the museum-search grid open the exact same viewer.
 */

import Lightbox from 'yet-another-react-lightbox';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';
import Captions from 'yet-another-react-lightbox/plugins/captions';
import Counter from 'yet-another-react-lightbox/plugins/counter';
import Download from 'yet-another-react-lightbox/plugins/download';
import 'yet-another-react-lightbox/styles.css';
import 'yet-another-react-lightbox/plugins/captions.css';
import 'yet-another-react-lightbox/plugins/counter.css';

import type { LightboxSlide } from '../lib/media';

export default function MediaLightbox({
  slides,
  index,
  onClose,
}: {
  slides: LightboxSlide[];
  index: number;        // -1 = closed
  onClose: () => void;
}) {
  return (
    <Lightbox
      open={index >= 0}
      index={index < 0 ? 0 : index}
      close={onClose}
      slides={slides}
      plugins={[Zoom, Captions, Counter, Download]}
      carousel={{ finite: true }}
      zoom={{ maxZoomPixelRatio: 4 }}
      counter={{ container: { style: { top: 'unset', bottom: 0 } } }}
      styles={{ container: { backgroundColor: 'rgba(8,6,4,.94)' } }}
    />
  );
}
