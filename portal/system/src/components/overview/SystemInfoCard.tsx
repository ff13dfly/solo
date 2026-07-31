import { Card, CardContent } from '../ui/Card';
import { SYSTEM_DESCRIPTION } from '../../utils/branding';

interface SystemInfoCardProps {
  t: (key: string) => string;
}

export const SystemInfoCard: React.FC<SystemInfoCardProps> = ({ t }) => {
  return (
    <Card title={t('overview.about_title')}>
      <CardContent className="p-4">
        <p className="text-xs text-text-secondary leading-relaxed">
          {SYSTEM_DESCRIPTION || t('overview.about_default')}
        </p>
      </CardContent>
    </Card>
  );
};
