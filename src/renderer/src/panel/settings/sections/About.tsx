import { Button, Card, icons } from '../../../ui'

const REPO = 'https://github.com/JanoTheDev/lumen'

export function About(): JSX.Element {
  const open = (url: string): void => window.lumen.send('assistant:open-link', url)
  return (
    <Card
      title="Lumen"
      description="A Windows companion that listens, points and helps you use any app. Open source."
    >
      <div className="panel-row">
        <Button icon={icons.external} onClick={() => open(REPO)}>
          Source code
        </Button>
        <Button icon={icons.external} onClick={() => open(`${REPO}/releases`)}>
          Releases
        </Button>
        <Button icon={icons.external} onClick={() => open(`${REPO}/blob/master/LICENSE`)}>
          Licence
        </Button>
      </div>
    </Card>
  )
}
