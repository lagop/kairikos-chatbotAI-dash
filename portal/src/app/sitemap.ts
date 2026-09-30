import type { MetadataRoute } from 'next';
import { portalBaseUrl } from '@/lib/portal-base-url';

// Lo único del portal que tiene que encontrar Google: la calculadora, que es
// un gancho enlazado desde kairikos.com. El resto o es privado o vive en la
// web (kairikos.com/wp-sitemap.xml).
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: `${portalBaseUrl()}/calculadora`, changeFrequency: 'monthly', priority: 0.8 }];
}
