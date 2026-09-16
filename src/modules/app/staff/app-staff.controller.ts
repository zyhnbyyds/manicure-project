import {
  Body,
  Controller,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../../common/auth/public.decorator';
import {
  appStaffApplyRequestSchema,
  type AppStaffApplyVo,
} from '../dto/app-vo';
import {
  AppAccessTokenGuard,
  type AppRequest,
} from '../auth/app-access-token.guard';
import { AppStaffService } from './app-staff.service';

/** 小程序美甲师工作台入口；申请本身允许 pending/rejected 身份访问，不能套 active scope guard。 */
@ApiTags('小程序端 - 美甲师')
@Public()
@Controller('app/staff')
export class AppStaffController {
  constructor(private readonly staff: AppStaffService) {}

  @Post('apply')
  @UseGuards(AppAccessTokenGuard)
  @ApiBearerAuth('app-token')
  @ApiOperation({
    summary: '申请美甲师工作台',
    description:
      '从当前 app 身份已绑定的手机号匹配在职美甲师档案，置为 pending；' +
      '店长确认前不会开通工作台。重复申请幂等。',
  })
  @ApiBody({ schema: { $ref: '#/components/schemas/AppStaffApplyRequest' } })
  @ApiResponse({
    status: 200,
    description: '申请状态',
    schema: { $ref: '#/components/schemas/AppStaffApplyVo' },
  })
  @ApiResponse({ status: 400, description: '未绑定手机号或未匹配在职美甲师' })
  @ApiResponse({ status: 401, description: '未登录' })
  @ApiResponse({ status: 409, description: '现有美甲师授权与手机号档案不一致' })
  apply(
    @Req() request: AppRequest,
    @Body() body: unknown,
  ): Promise<AppStaffApplyVo> {
    const appUser = request.appUser;
    if (!appUser) throw new UnauthorizedException();
    // body 只为保持请求契约与 Swagger 完整；身份字段全部丢弃，不能靠请求体提权。
    appStaffApplyRequestSchema.parse(body);
    return this.staff.apply(appUser.id);
  }
}
