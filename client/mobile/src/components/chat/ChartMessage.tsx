import ReactECharts from 'echarts-for-react';
import type { Message } from "../../types";

interface ChartMessageProps {
  message: Message;
}

export function ChartMessage({ message }: ChartMessageProps) {
  const chartData = message.payload?.data || [];
  const title = message.payload?.title || "Data Overview";

  // Construct ECharts option
  const option = {
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'shadow'
      }
    },
    grid: {
      left: '3%',
      right: '4%',
      bottom: '3%',
      containLabel: true
    },
    xAxis: [
      {
        type: 'category',
        data: chartData.map((d: any) => d.name),
        axisTick: {
          alignWithLabel: true
        },
        axisLabel: {
            fontSize: 10
        }
      }
    ],
    yAxis: [
      {
        type: 'value',
        axisLabel: {
            fontSize: 10
        }
      }
    ],
    series: [
      {
        name: 'Sales',
        type: 'bar',
        barWidth: '60%',
        data: chartData.map((d: any) => d.value),
        itemStyle: {
            color: '#5470C6'
        },
        // Simple animation
        animationDuration: 1500,
      }
    ]
  };

  return (
    <div className="bg-white rounded-lg p-3 max-w-[90%] shadow-sm w-[300px]">
      <div className="text-sm font-semibold mb-2 border-b pb-1 text-gray-700">{title}</div>
      <div className="w-full h-[200px]">
        <ReactECharts 
          option={option} 
          style={{ height: '100%', width: '100%' }}
          opts={{ renderer: 'svg' }}
        />
      </div>
    </div>
  );
}
