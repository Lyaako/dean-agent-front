import { Page } from "../components/Shell";
import { Icon } from "../components/Icon";

export const ComingSoonPage = ({ title }: { title: string }) => (
  <Page title={title}>
    <section className="card empty-day"><Icon name="chart" /><b>Скоро</b>Этот раздел появится на следующем этапе</section>
  </Page>
);
