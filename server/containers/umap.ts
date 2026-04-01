import { Container } from '@cloudflare/containers'

export class UmapContainer extends Container {
  defaultPort = 8080
  sleepAfter = '5m'
}
